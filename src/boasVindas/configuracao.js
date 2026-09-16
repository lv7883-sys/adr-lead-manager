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
const crypto = require('crypto');
const { withTenant } = require('../db');
const mediaLib = require('../media');
const R = require('../boasVindasRegua');
const dados = require('./dados');
const agendaAdR = require('./agendaAcademiaDoRock');

const MODOS_DISPONIVEIS = ['desligado', 'avisa'];   // 'auto' é a E17-05
const TIPO_POR_MIDIA = { image: 'imagem', video: 'video', audio: 'audio', document: 'documento' };

const SQL_ETAPAS_COM_ANEXO = `
SELECT e.id, e.ordem, e.nome, e.ancora, e.quando, e.repeticoes, e.contrato_curto, e.texto_titular, e.texto_responsavel,
       e.anexo_id, e.anexo_sugerido, e.entregue_por, e.ativo, e.atualizado_por, e.atualizado_em,
       a.nome_arquivo AS anexo_nome, a.tipo AS anexo_tipo, a.mime AS anexo_mime, a.caminho AS anexo_url,
       a.tamanho_bytes AS anexo_tamanho, a.enviado_em AS anexo_enviado_em, a.enviado_por AS anexo_enviado_por
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
  return e;
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
      erros.push(novo.modo === 'auto' ? 'O envio automático ainda não está disponível. Use "avisa".' : 'Modo inválido.');
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
          SET boas_vindas_modo = $2, boas_vindas_alerta_dias = $3, boas_vindas_variaveis = $4::jsonb
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

const CAMPOS_ETAPA = ['nome', 'texto_titular', 'texto_responsavel', 'ativo', 'contrato_curto', 'quando_dias'];

// Edita UMA mensagem. Valida a régua inteira com a mudança aplicada e só recusa erros NOVOS — um problema
// que já existia (ex.: variável da unidade ainda não cadastrada) não impede corrigir outra mensagem.
async function salvarEtapa(tenantId, etapaId, patch = {}, por, { fonte = agendaAdR } = {}) {
  return withTenant(tenantId, async (c) => {
    const ctx = await _contexto(c, tenantId, fonte);
    const atual = ctx.etapas.find((e) => e.id === etapaId);
    if (!atual) throw Object.assign(new Error('etapa_nao_encontrada'), { status: 404 });

    const mudanca = {};
    for (const k of CAMPOS_ETAPA) if (Object.prototype.hasOwnProperty.call(patch, k)) mudanca[k] = patch[k];
    if (typeof mudanca.nome === 'string') mudanca.nome = mudanca.nome.trim().slice(0, 80);
    for (const k of ['texto_titular', 'texto_responsavel']) {
      if (k in mudanca) mudanca[k] = mudanca[k] == null || !String(mudanca[k]).trim() ? null : String(mudanca[k]).replace(/\r\n/g, '\n').slice(0, 4000);
    }
    for (const k of ['ativo', 'contrato_curto']) if (k in mudanca) mudanca[k] = mudanca[k] === true || mudanca[k] === 'true';
    let quando = atual.quando;
    if ('quando_dias' in mudanca) {
      if (atual.quando.tipo !== 'dias') throw new ErroValidacao('quando_fixo', ['O momento desta mensagem é preso à aula e não se edita em dias.']);
      quando = { tipo: 'dias', valor: Number(mudanca.quando_dias) };
      delete mudanca.quando_dias;
    }

    const candidata = { ...atual, ...mudanca, quando };
    if (!candidata.nome) throw new ErroValidacao('nome_vazio', ['Dê um nome à mensagem.']);
    const regua = ctx.etapas.map((e) => (e.id === etapaId ? candidata : e));
    const antes = new Set(_validar(ctx.etapas, ctx).erros);
    const novos = _validar(regua, ctx).erros.filter((m) => !antes.has(m));
    if (novos.length) throw new ErroValidacao('regua_invalida', novos);

    await c.query(
      `UPDATE lead_manager.boas_vindas_etapa
          SET nome = $3, texto_titular = $4, texto_responsavel = $5, ativo = $6, contrato_curto = $7, quando = $8::jsonb,
              atualizado_por = $9, atualizado_em = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, etapaId, candidata.nome, candidata.texto_titular, candidata.texto_responsavel, candidata.ativo,
        candidata.contrato_curto, JSON.stringify(quando), por || null]);
    return { ok: true, avisos: [..._validar(regua, ctx).erros] };
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

module.exports = { obter, salvarConfig, copiarModelo, salvarEtapa, anexar, removerAnexo, ErroValidacao, MODOS_DISPONIVEIS };
