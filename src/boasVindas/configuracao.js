'use strict';
//
// configuracao.js — ADR-050 (E17-03/04). O lado da GESTÃO da unidade: ligar o módulo, variáveis da
// unidade (ex.: link do EAD), copiar um modelo, editar o texto de cada mensagem e ANEXAR o arquivo de
// cada uma (imagem, vídeo, áudio ou documento). Cada unidade tem os próprios arquivos — o "Guia rápido"
// de Valinhos é só o de Valinhos.
//
// Regra de não regressão (ADR-050 §13.3): as colunas boas_vindas_* de automacao_config são gravadas
// SÓ aqui, com UPDATE apenas delas — nunca pelo PUT /automacao.
//
// E17-04 — a unidade monta a PRÓPRIA régua: cria, apaga e reordena mensagens e muda o momento de cada
// uma (âncora, tipo e repetições). Com o módulo LIGADO, uma mudança que cria erro de régua novo é
// recusada; DESLIGADO, grava e devolve os avisos (a régua só liga quando estiver válida — salvarConfig).
// Mensagem com histórico (enviada, tratada ou descartada pela recepção) não se apaga: desliga.
// O aviso de tema sensível (§6.4) usa temaProibido.detectarSaida só para AVISAR; nunca bloqueia.
//
const crypto = require('crypto');
const { withTenant } = require('../db');
const mediaLib = require('../media');
const R = require('../boasVindasRegua');
const temaProibido = require('../temaProibido');
const dados = require('./dados');
const agendaAdR = require('./agendaAcademiaDoRock');

const MODOS_DISPONIVEIS = ['desligado', 'avisa', 'auto'];
const TIPO_POR_MIDIA = { image: 'imagem', video: 'video', audio: 'audio', document: 'documento' };

const SQL_ETAPAS_COM_ANEXO = `
SELECT e.id, e.ordem, e.nome, e.ancora, e.quando, e.repeticoes, e.contrato_curto, e.texto_titular, e.texto_responsavel,
       e.anexo_id, e.anexo_sugerido, e.entregue_por, e.ativo, e.atualizado_por, e.atualizado_em,
       a.nome_arquivo AS anexo_nome, a.tipo AS anexo_tipo, a.mime AS anexo_mime, a.caminho AS anexo_url,
       a.tamanho_bytes AS anexo_tamanho, a.enviado_em AS anexo_enviado_em, a.enviado_por AS anexo_enviado_por,
       (SELECT count(*) FROM lead_manager.boas_vindas_toque t
         WHERE t.tenant_id = e.tenant_id AND t.etapa_id = e.id AND t.status IN ('aprovado', 'enviado', 'erro', 'descartado'))::int AS historico
  FROM lead_manager.boas_vindas_etapa e
  LEFT JOIN lead_manager.boas_vindas_anexo a ON a.tenant_id = e.tenant_id AND a.id = e.anexo_id
 WHERE e.tenant_id = $1
 ORDER BY e.ordem`;

class ErroValidacao extends Error {
  constructor(codigo, erros = []) { super(codigo); this.codigo = codigo; this.erros = erros; this.status = 422; }
}

function _etapa(row) {
  const e = dados.etapaDaLinha(row);
  e.anexo = row.anexo_id ? {
    id: row.anexo_id, nome: row.anexo_nome, tipo: row.anexo_tipo, mime: row.anexo_mime, url: row.anexo_url,
    tamanho: Number(row.anexo_tamanho), enviadoEm: row.anexo_enviado_em, enviadoPor: row.anexo_enviado_por,
  } : null;
  for (const k of ['anexo_nome', 'anexo_tipo', 'anexo_mime', 'anexo_url', 'anexo_tamanho', 'anexo_enviado_em', 'anexo_enviado_por']) delete e[k];
  e.temas = temasSensiveis(e);
  return e;
}

// §6.4 — o texto aprovado pela gestão NÃO passa pela trava da IA; a tela só avisa quando ele fala de
// contrato ou valores, para a gestão conferir antes de ligar o envio automático. "Agenda" fica de fora de
// propósito: lembrete de aula fala de dia e horário por natureza (o aviso tocaria em toda régua).
const TEMA_ROTULO = { contrato: 'contrato', valores: 'valores' };
function temasSensiveis(etapa) {
  if (!etapa || etapa.entregue_por === 'externo') return [];
  const achados = new Map();
  for (const texto of [etapa.texto_titular, etapa.texto_responsavel]) {
    if (!texto) continue;
    const det = temaProibido.detectarSaida(String(texto).replace(/\{[a-z][a-z0-9_]*\}/g, ' '));
    for (const k of Object.keys(TEMA_ROTULO)) if (det[k] && !achados.has(k)) achados.set(k, det[k]);
  }
  return [...achados].map(([tema, trecho]) => ({ tema, trecho: String(trecho).slice(0, 60) }));
}

// Valores de exemplo para a prévia da mensagem na tela (vocabulário neutro: serve a qualquer ramo).
function exemplos(config) {
  const d = R.somarDias(R.dataSP(Date.now()), 3);
  return {
    cliente: 'Ana', responsavel: 'Carla', empresa: config.empresa || config.tenantNome || 'Sua empresa',
    servico: 'o serviço contratado', profissional: 'Marcos', dia: R.formatarDia(d), horario: '15h',
    ...(config.variaveis || {}),
  };
}

async function _contexto(c, tenantId, fonte) {
  const config = await dados.carregarConfig(c, tenantId);
  const etapas = (await c.query(SQL_ETAPAS_COM_ANEXO, [tenantId])).rows.map(_etapa);
  const agenda = await fonte.disponibilidade(c, tenantId);
  const ancorasDisponiveis = agenda.ok ? fonte.ANCORAS : ['inicio_contrato'];
  return { config, etapas, agenda, ancorasDisponiveis };
}

function _validar(etapas, ctx) {
  return R.validarRegua(etapas, {
    ancorasDisponiveis: ctx.ancorasDisponiveis,
    variaveisLivres: Object.keys(ctx.config.variaveis || {}),
  });
}

async function obter(tenantId, { fonte = agendaAdR } = {}) {
  return withTenant(tenantId, async (c) => {
    const ctx = await _contexto(c, tenantId, fonte);
    const modelos = (await c.query(
      `SELECT m.slug, m.nome, m.ramo, m.descricao, count(me.*)::int AS etapas
         FROM lead_manager.boas_vindas_modelo m
         LEFT JOIN lead_manager.boas_vindas_modelo_etapa me ON me.modelo_slug = m.slug
        WHERE m.ativo GROUP BY m.slug ORDER BY m.nome`)).rows;
    return {
      config: ctx.config,
      etapas: ctx.etapas,
      modelos,
      agenda: { ok: ctx.agenda.ok, motivo: ctx.agenda.ok ? null : ctx.agenda.motivo },
      validacao: ctx.etapas.length ? _validar(ctx.etapas, ctx) : { ok: false, erros: ['A unidade ainda não tem régua. Escolha um modelo para começar.'] },
      modos: MODOS_DISPONIVEIS,
      variaveisSistema: R.VARIAVEIS_SISTEMA,
      ancorasDisponiveis: ctx.ancorasDisponiveis,
      tiposQuando: R.TIPOS_QUANDO,
      limites: {
        maxMensagens: R.LIMITES.MAX_ETAPAS, minLigadas: R.LIMITES.MIN_ETAPAS, maxDias: R.LIMITES.OFFSET_MAX_DIAS,
        maxRepeticoes: R.LIMITES.MAX_REPETICOES, primeiraMaxDias: R.LIMITES.PRIMEIRA_MAX_DIAS,
        espacoMinDias: R.LIMITES.ESPACO_MIN_HORAS / 24,
      },
      exemplos: exemplos(ctx.config),
      anexos: Object.fromEntries(Object.entries(R.ANEXO).map(([k, v]) => [k, { formatos: v.mimes, maxBytes: v.maxBytes }])),
      limiteLegenda: R.LIMITE_LEGENDA,
      alerta: { min: R.LIMITES.ALERTA_MIN, max: R.LIMITES.ALERTA_MAX },
    };
  });
}

async function salvarConfig(tenantId, { modo, alertaDias, variaveis } = {}, { fonte = agendaAdR } = {}) {
  return withTenant(tenantId, async (c) => {
    const ctx = await _contexto(c, tenantId, fonte);
    const novo = {
      modo: modo == null ? ctx.config.modo : String(modo),
      alertaDias: alertaDias == null ? ctx.config.alertaDias : Number(alertaDias),
      variaveis: variaveis == null ? ctx.config.variaveis : variaveis,
    };
    const erros = [];
    if (!MODOS_DISPONIVEIS.includes(novo.modo)) {
      erros.push('Modo inválido.');
    }
    erros.push(...R.validarAlertaDias(novo.alertaDias), ...R.validarVariaveisLivres(novo.variaveis));
    if (!erros.length && novo.modo !== 'desligado') {
      if (!ctx.etapas.length) erros.push('Escolha um modelo antes de ligar as boas-vindas.');
      else erros.push(...R.validarRegua(ctx.etapas, { ancorasDisponiveis: ctx.ancorasDisponiveis, variaveisLivres: Object.keys(novo.variaveis) }).erros);
    }
    if (erros.length) throw new ErroValidacao('config_invalida', erros);
    await c.query('INSERT INTO lead_manager.automacao_config (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);
    await c.query(
      `UPDATE lead_manager.automacao_config
          SET boas_vindas_modo = $2, boas_vindas_alerta_dias = $3, boas_vindas_variaveis = $4::jsonb,
              -- saiu de 'desligado': o que já venceu antes de agora não vai para ninguém (R6, E17-05)
              boas_vindas_ativado_em = CASE WHEN $2 <> 'desligado' AND boas_vindas_modo = 'desligado' THEN now()
                                            ELSE boas_vindas_ativado_em END
        WHERE tenant_id = $1`,
      [tenantId, novo.modo, novo.alertaDias, JSON.stringify(novo.variaveis)]);
    return { ok: true, config: novo };
  });
}

async function copiarModelo(tenantId, slug, por) {
  return withTenant(tenantId, async (c) => {
    try {
      const n = (await c.query('SELECT lead_manager.boas_vindas_copiar_modelo($1, $2, $3) AS n', [tenantId, slug, por || null])).rows[0].n;
      await c.query('INSERT INTO lead_manager.automacao_config (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);
      await c.query('UPDATE lead_manager.automacao_config SET boas_vindas_modelo = $2 WHERE tenant_id = $1', [tenantId, slug]);
      return { ok: true, etapas: n };
    } catch (e) {
      if (e.code === '23505') throw new ErroValidacao('ja_tem_regua', ['A unidade já tem régua; o modelo não sobrescreve o que foi editado.']);
      if (e.code === 'P0002') throw new ErroValidacao('modelo_inexistente', ['Modelo não encontrado.']);
      throw e;
    }
  });
}

const CAMPOS_ETAPA = ['nome', 'texto_titular', 'texto_responsavel', 'ativo', 'contrato_curto', 'quando_dias', 'ancora', 'quando', 'repeticoes'];
const SEM_HISTORICO = ['pendente', 'bloqueado', 'fora_da_janela'];

const _texto = (v) => (v == null || !String(v).trim() ? null : String(v).replace(/\r\n/g, '\n').slice(0, 4000));
const _bool = (v) => v === true || v === 'true';
const _mesmoMomento = (a, b) => a.ancora === b.ancora && JSON.stringify(a.quando) === JSON.stringify(b.quando) && a.repeticoes === b.repeticoes;

// Momento da mensagem vindo da tela → { ancora, quando, repeticoes } normalizado. `quando.valor` só existe
// no tipo "dias"; repetição só vale para atendimento agendado (o resto é 1).
function _momento(patch, atual) {
  const ancora = patch.ancora != null ? String(patch.ancora) : atual.ancora;
  let quando = atual.quando;
  if (patch.quando != null && typeof patch.quando === 'object') {
    const tipo = String(patch.quando.tipo || '');
    quando = tipo === 'dias' ? { tipo, valor: Number(patch.quando.valor) } : { tipo };
  }
  let repeticoes = patch.repeticoes != null ? Number(patch.repeticoes) : atual.repeticoes;
  if (ancora !== 'atendimento_agendado') repeticoes = 1;
  return { ancora, quando, repeticoes };
}

// Com o módulo ligado, recusa erro de régua que a mudança CRIA (um problema que já existia não impede
// corrigir outra mensagem). Desligado, só devolve os avisos: a régua é validada inteira ao ligar.
function _conferir(ctx, antes, depois) {
  const errosDepois = _validar(depois, ctx).erros;
  if (ctx.config.modo !== 'desligado') {
    const ja = new Set(_validar(antes, ctx).erros);
    const novos = errosDepois.filter((m) => !ja.has(m));
    if (novos.length) throw new ErroValidacao('regua_invalida', novos);
  }
  return errosDepois;
}

// A própria mensagem precisa ser estruturalmente válida (mesmo desligada): é o que os CHECKs do banco exigem.
function _conferirEtapa(etapa) {
  const erros = R.validarEtapa(etapa);
  if (etapa.ancora && !R.ANCORAS.includes(etapa.ancora)) erros.push('Momento de referência inválido.');
  if (erros.length) throw new ErroValidacao('etapa_invalida', erros);
}

// Mensagens ainda não tratadas pela recepção de uma etapa cujo momento mudou (ou que foi desligada):
// saem da fila e a rotina recria no momento novo. Nada do histórico é tocado.
async function _limparNaoTratadas(c, tenantId, etapaId) {
  const r = await c.query(
    'DELETE FROM lead_manager.boas_vindas_toque WHERE tenant_id = $1 AND etapa_id = $2 AND status = ANY($3::text[])',
    [tenantId, etapaId, SEM_HISTORICO]);
  return r.rowCount;
}

// Edita UMA mensagem: nome, textos, ligada, contrato curto e o momento (âncora, tipo, dias, repetições).
async function salvarEtapa(tenantId, etapaId, patch = {}, por, { fonte = agendaAdR } = {}) {
  return withTenant(tenantId, async (c) => {
    const ctx = await _contexto(c, tenantId, fonte);
    const atual = ctx.etapas.find((e) => e.id === etapaId);
    if (!atual) throw Object.assign(new Error('etapa_nao_encontrada'), { status: 404 });

    const mudanca = {};
    for (const k of CAMPOS_ETAPA) if (Object.prototype.hasOwnProperty.call(patch, k)) mudanca[k] = patch[k];
    if (atual.entregue_por === 'externo' && Object.keys(mudanca).some((k) => !['nome', 'ativo'].includes(k))) {
      throw new ErroValidacao('etapa_externa', ['Esta mensagem é enviada por outro módulo; aqui só dá para mudar o nome e ligar ou desligar.']);
    }
    // Compatível com a E17-03: `quando_dias` só serve para etapa que já é "em dias".
    if ('quando_dias' in mudanca) {
      if (atual.quando.tipo !== 'dias') throw new ErroValidacao('quando_fixo', ['O momento desta mensagem é preso à aula e não se edita em dias.']);
      if (!mudanca.quando) mudanca.quando = { tipo: 'dias', valor: mudanca.quando_dias };
      delete mudanca.quando_dias;
    }

    const candidata = { ...atual, ..._momento(mudanca, atual) };
    if ('nome' in mudanca) candidata.nome = String(mudanca.nome || '').trim().slice(0, 80);
    for (const k of ['texto_titular', 'texto_responsavel']) if (k in mudanca) candidata[k] = _texto(mudanca[k]);
    for (const k of ['ativo', 'contrato_curto']) if (k in mudanca) candidata[k] = _bool(mudanca[k]);
    if (!candidata.nome) throw new ErroValidacao('nome_vazio', ['Dê um nome à mensagem.']);
    _conferirEtapa(candidata);

    const regua = ctx.etapas.map((e) => (e.id === etapaId ? candidata : e));
    const avisos = _conferir(ctx, ctx.etapas, regua);

    await c.query(
      `UPDATE lead_manager.boas_vindas_etapa
          SET nome = $3, texto_titular = $4, texto_responsavel = $5, ativo = $6, contrato_curto = $7, quando = $8::jsonb,
              ancora = $9, repeticoes = $10, atualizado_por = $11, atualizado_em = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, etapaId, candidata.nome, candidata.texto_titular, candidata.texto_responsavel, candidata.ativo,
        candidata.contrato_curto, JSON.stringify(candidata.quando), candidata.ancora, candidata.repeticoes, por || null]);

    const desligou = atual.ativo && !candidata.ativo;
    const removidas = (desligou || !_mesmoMomento(atual, candidata)) ? await _limparNaoTratadas(c, tenantId, etapaId) : 0;
    return { ok: true, avisos, temas: temasSensiveis(candidata), filaRemovidas: removidas };
  });
}

// Cria uma mensagem no fim da régua. Com o módulo ligado, se ela criaria erro de régua, nasce DESLIGADA
// (a gestão completa e liga depois) — nunca some o que foi escrito.
async function criarEtapa(tenantId, campos = {}, por, { fonte = agendaAdR } = {}) {
  return withTenant(tenantId, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`boas_vindas_etapa:${tenantId}`]);
    const ctx = await _contexto(c, tenantId, fonte);
    if (ctx.etapas.length >= R.LIMITES.MAX_ETAPAS) {
      throw new ErroValidacao('limite_de_mensagens', [`A unidade pode ter no máximo ${R.LIMITES.MAX_ETAPAS} mensagens, contando as desligadas. Apague uma que não usa.`]);
    }
    const base = { ancora: 'inicio_contrato', quando: { tipo: 'dias', valor: 7 }, repeticoes: 1 };
    const nova = {
      id: 'nova', ordem: ctx.etapas.reduce((m, e) => Math.max(m, e.ordem), 0) + 1,
      nome: String(campos.nome || '').trim().slice(0, 80),
      ..._momento(campos, base),
      contrato_curto: _bool(campos.contrato_curto),
      texto_titular: _texto(campos.texto_titular), texto_responsavel: _texto(campos.texto_responsavel),
      anexo_id: null, entregue_por: 'regente', ativo: true,
    };
    if (!nova.nome) throw new ErroValidacao('nome_vazio', ['Dê um nome à mensagem.']);
    _conferirEtapa(nova);

    let avisos;
    try {
      avisos = _conferir(ctx, ctx.etapas, [...ctx.etapas, nova]);
    } catch (e) {
      if (e.codigo !== 'regua_invalida') throw e;
      nova.ativo = false;
      avisos = e.erros;
    }
    const { id } = (await c.query(
      `INSERT INTO lead_manager.boas_vindas_etapa
         (tenant_id, ordem, nome, ancora, quando, repeticoes, contrato_curto, texto_titular, texto_responsavel, ativo, atualizado_por)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [tenantId, nova.ordem, nova.nome, nova.ancora, JSON.stringify(nova.quando), nova.repeticoes, nova.contrato_curto,
        nova.texto_titular, nova.texto_responsavel, nova.ativo, por || null])).rows[0];
    return { ok: true, id, ligada: nova.ativo, avisos, temas: temasSensiveis(nova) };
  });
}

// Renumera 1..n na ordem dada (a unicidade da posição é conferida só no fim da transação).
async function _renumerar(c, tenantId, ids) {
  await c.query('SET CONSTRAINTS lead_manager.boas_vindas_etapa_ordem_uq DEFERRED');
  await c.query(
    `UPDATE lead_manager.boas_vindas_etapa e SET ordem = n.pos
       FROM unnest($2::uuid[]) WITH ORDINALITY AS n(id, pos)
      WHERE e.tenant_id = $1 AND e.id = n.id AND e.ordem <> n.pos`,
    [tenantId, ids]);
}

// Apaga uma mensagem SEM histórico. A que já foi enviada/tratada pela recepção fica (desliga-se).
async function apagarEtapa(tenantId, etapaId, por, { fonte = agendaAdR } = {}) {
  return withTenant(tenantId, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`boas_vindas_etapa:${tenantId}`]);
    const ctx = await _contexto(c, tenantId, fonte);
    const alvo = ctx.etapas.find((e) => e.id === etapaId);
    if (!alvo) throw Object.assign(new Error('etapa_nao_encontrada'), { status: 404 });
    if (alvo.historico > 0) {
      throw new ErroValidacao('etapa_com_historico', ['Esta mensagem já foi enviada ou tratada pela recepção e faz parte do histórico. Desligue em vez de apagar.']);
    }
    const resto = ctx.etapas.filter((e) => e.id !== etapaId);
    const avisos = _conferir(ctx, ctx.etapas, resto);
    const removidas = await _limparNaoTratadas(c, tenantId, etapaId);
    await c.query('DELETE FROM lead_manager.boas_vindas_etapa WHERE tenant_id = $1 AND id = $2', [tenantId, etapaId]);
    await _renumerar(c, tenantId, resto.map((e) => e.id));
    return { ok: true, avisos, filaRemovidas: removidas };
  });
}

// Nova ordem das mensagens (lista completa de ids). A ordem desempata quem sai primeiro no mesmo dia (R7).
async function reordenarEtapas(tenantId, ids) {
  const lista = Array.isArray(ids) ? ids.map(String) : [];
  return withTenant(tenantId, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`boas_vindas_etapa:${tenantId}`]);
    const atuais = (await c.query('SELECT id FROM lead_manager.boas_vindas_etapa WHERE tenant_id = $1', [tenantId])).rows.map((r) => r.id);
    const iguais = lista.length === atuais.length && new Set(lista).size === lista.length && lista.every((id) => atuais.includes(id));
    if (!iguais) throw new ErroValidacao('ordem_invalida', ['A lista de mensagens mudou. Recarregue a página e tente de novo.']);
    await _renumerar(c, tenantId, lista);
    return { ok: true };
  });
}

// Anexa (ou troca) o arquivo de uma mensagem. `file` = { buffer, mimetype, originalname } (multer).
async function anexar(tenantId, etapaId, file, por, deps = {}) {
  const salvar = deps.salvarBuffer || mediaLib.salvarBuffer;
  if (!file || !file.buffer || !file.buffer.length) throw new ErroValidacao('arquivo_vazio', ['Arquivo vazio.']);
  const mime = String(file.mimetype || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const tipo = TIPO_POR_MIDIA[mediaLib.tipoDeMime(mime)];
  const erros = R.validarAnexo({ tipo, mime, tamanhoBytes: file.buffer.length });
  if (erros.length) throw new ErroValidacao('anexo_invalido', erros);

  return withTenant(tenantId, async (c) => {
    const etapa = (await c.query('SELECT id FROM lead_manager.boas_vindas_etapa WHERE tenant_id = $1 AND id = $2', [tenantId, etapaId])).rows[0];
    if (!etapa) throw Object.assign(new Error('etapa_nao_encontrada'), { status: 404 });
    const nome = String(file.originalname || `arquivo.${mime.split('/')[1] || 'bin'}`).replace(/[\r\n"]/g, '').slice(0, 200);
    const salvo = salvar({ tenantId, buffer: file.buffer, mimetype: mime, filename: nome });
    const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const anexo = (await c.query(
      `INSERT INTO lead_manager.boas_vindas_anexo (tenant_id, nome_arquivo, mime, tipo, tamanho_bytes, caminho, sha256, enviado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, nome_arquivo AS nome, mime, tipo, caminho AS url, tamanho_bytes AS tamanho, enviado_em AS "enviadoEm"`,
      [tenantId, nome, mime, tipo, file.buffer.length, salvo.media_url, sha, por || null])).rows[0];
    await c.query(
      'UPDATE lead_manager.boas_vindas_etapa SET anexo_id = $3, atualizado_por = $4, atualizado_em = now() WHERE tenant_id = $1 AND id = $2',
      [tenantId, etapaId, anexo.id, por || null]);
    return { ok: true, anexo: { ...anexo, tamanho: Number(anexo.tamanho) } };
  });
}

// Tira o arquivo da mensagem. O registro do arquivo fica (histórico do que já foi enviado).
async function removerAnexo(tenantId, etapaId, por) {
  return withTenant(tenantId, async (c) => {
    try {
      const r = await c.query(
        'UPDATE lead_manager.boas_vindas_etapa SET anexo_id = NULL, atualizado_por = $3, atualizado_em = now() WHERE tenant_id = $1 AND id = $2 RETURNING id',
        [tenantId, etapaId, por || null]);
      if (!r.rows.length) throw Object.assign(new Error('etapa_nao_encontrada'), { status: 404 });
      return { ok: true };
    } catch (e) {
      if (e.code === '23514') throw new ErroValidacao('mensagem_vazia', ['A mensagem ficaria sem texto e sem arquivo. Escreva um texto antes de tirar o arquivo.']);
      throw e;
    }
  });
}

module.exports = {
  obter, salvarConfig, copiarModelo, salvarEtapa, criarEtapa, apagarEtapa, reordenarEtapas, anexar, removerAnexo,
  temasSensiveis, ErroValidacao, MODOS_DISPONIVEIS,
};
