'use strict';
//
// recepcao.js — ADR-050 (E17-03). O lado da RECEPÇÃO: a fila de mensagens de boas-vindas prontas, e as
// ações de enviar (com o anexo da etapa) e descartar. O envio reusa o caminho da Caixa de Entrada
// (sendMessage / sendInboxMedia / sendInboxAudio + ensureConversation), então a mensagem aparece na
// conversa da família com os tiques, igual a qualquer envio da recepção.
//
// Consulta PRÓPRIA (não entra na consulta da lista da Caixa de Entrada): a aba Boas-vindas não pode
// deixar Todas/Leads/Renovações mais lentas.
//
// E17-05: no modo "auto" a fila mostra só o que precisa de gente — bloqueada (falta dado/arquivo) ou que
// já falhou uma vez; o resto sai sozinho (src/boasVindas/auto.js). Os ALERTAS de cliente que não começou
// vêm junto (listarAlertas) e a recepção pode dispensar com uma observação.
//
const fs = require('fs');
const path = require('path');
const { withTenant } = require('../db');
const mediaLib = require('../media');
const R = require('../boasVindasRegua');

const ESTADOS_ABERTOS = ['pendente', 'bloqueado'];

// Mensagens prontas agora (devidas) de unidades com o módulo ligado. Casa a conversa da família pela
// mesma chave de telefone da Caixa de Entrada (br_key). Sem conversa → conversation_id null (o envio cria).
const SQL_FILA = `
SELECT bt.id, bt.account_id, bt.etapa_id, bt.repeticao, bt.status, bt.bloqueio, bt.motivo, bt.due_at, bt.versao,
       bt.phone, bt.destinatario_nome, bt.cliente_nome, bt.texto_final, bt.erro, ac.boas_vindas_modo AS modo,
       e.nome AS etapa_nome, e.ordem, e.repeticoes, e.anexo_sugerido,
       a.id AS anexo_id, a.nome_arquivo AS anexo_nome, a.tipo AS anexo_tipo, a.mime AS anexo_mime,
       a.caminho AS anexo_url, a.enviado_em AS anexo_atualizado_em,
       (SELECT count(*)::int FROM lead_manager.boas_vindas_etapa e2
         WHERE e2.tenant_id = $1 AND e2.ativo AND e2.entregue_por = 'regente') AS total_etapas,
       cv.id AS conversation_id
  FROM lead_manager.boas_vindas_toque bt
  JOIN lead_manager.boas_vindas_etapa e ON e.tenant_id = bt.tenant_id AND e.id = bt.etapa_id
  JOIN lead_manager.automacao_config ac ON ac.tenant_id = bt.tenant_id AND ac.boas_vindas_modo <> 'desligado'
  LEFT JOIN lead_manager.boas_vindas_anexo a ON a.tenant_id = e.tenant_id AND a.id = e.anexo_id
  LEFT JOIN LATERAL (
    SELECT c.id FROM lead_manager.conversations c
     WHERE c.tenant_id = $1 AND c.channel = 'whatsapp' AND bt.phone IS NOT NULL
       AND c.br_key = lead_manager.br_phone_key(bt.phone)
     ORDER BY c.last_activity_at DESC NULLS LAST LIMIT 1
  ) cv ON true
 WHERE bt.tenant_id = $1
   AND bt.status = ANY($2::text[])
   AND bt.due_at <= now()
   AND e.ativo
   AND (ac.boas_vindas_modo <> 'auto' OR bt.status = 'bloqueado' OR bt.erro IS NOT NULL)
   %FILTRO%
 ORDER BY bt.due_at, e.ordem, bt.id
 LIMIT $3`;

const MOTIVO_BLOQUEIO = {
  sem_telefone: 'Sem telefone no cadastro.',
  sem_horario: 'A aula ainda não está na agenda: complete o dia e o horário antes de enviar.',
  sem_profissional: 'Falta o professor: complete antes de enviar.',
  sem_anexo: 'O arquivo desta mensagem não foi encontrado.',
  sem_horario_atendimento: 'A unidade está sem horário de atendimento configurado.',
};

const MOTIVO_ERRO = {
  texto_com_variavel_sem_valor: 'O texto ficou com um campo sem valor. Complete antes de enviar.',
  anexo_nao_encontrado: 'O arquivo desta mensagem não foi encontrado. Troque em Configurações > Boas-vindas.',
  mensagem_vazia: 'A mensagem ficou sem texto e sem arquivo.',
  telefone_invalido: 'O telefone do cadastro não é válido para WhatsApp.',
};

function itemDaLinha(r) {
  const anexo = r.anexo_id ? {
    id: r.anexo_id, nome: r.anexo_nome, tipo: r.anexo_tipo, mime: r.anexo_mime, url: r.anexo_url,
    atualizadoEm: r.anexo_atualizado_em,
  } : null;
  return {
    id: r.id,
    accountId: r.account_id,
    conversationId: r.conversation_id || null,
    etapa: { id: r.etapa_id, nome: r.etapa_nome, ordem: r.ordem, repeticao: r.repeticao, repeticoes: r.repeticoes, total: r.total_etapas },
    status: r.status,
    bloqueio: r.bloqueio,
    aviso: r.bloqueio ? MOTIVO_BLOQUEIO[r.bloqueio] || 'Falta um dado para enviar.' : null,
    motivo: r.motivo,
    erro: r.erro ? (MOTIVO_ERRO[r.erro] || 'O envio automático não conseguiu mandar esta mensagem. Confira e envie.') : null,
    automatico: r.modo === 'auto',
    dueAt: r.due_at,
    versao: r.versao,
    phone: r.phone,
    destinatarioNome: r.destinatario_nome,
    clienteNome: r.cliente_nome,
    texto: r.texto_final || '',
    anexo,
    anexoSugerido: !anexo && r.anexo_sugerido ? r.anexo_sugerido : null,
    envio: R.planoDeEnvio({ texto: r.texto_final || '', anexo: anexo ? { id: anexo.id, tipo: anexo.tipo } : null }).map((p) => p.kind),
  };
}

async function listarFila(tenantId, { limite = 200, conversationId = null } = {}) {
  const params = [tenantId, ESTADOS_ABERTOS, Math.min(Math.max(1, limite | 0), 500)];
  let filtro = '';
  if (conversationId) { params.push(conversationId); filtro = `AND cv.id = $${params.length}::uuid`; }
  return withTenant(tenantId, async (c) => (await c.query(SQL_FILA.replace('%FILTRO%', filtro), params)).rows.map(itemDaLinha));
}

async function detalhe(tenantId, toqueId) {
  const params = [tenantId, ESTADOS_ABERTOS, 1, toqueId];
  const sql = SQL_FILA.replace('%FILTRO%', 'AND bt.id = $4::uuid').replace('AND bt.due_at <= now()', '')
    .replace("AND (ac.boas_vindas_modo <> 'auto' OR bt.status = 'bloqueado' OR bt.erro IS NOT NULL)", '');
  return withTenant(tenantId, async (c) => {
    const r = (await c.query(sql, params)).rows[0];
    return r ? itemDaLinha(r) : null;
  });
}

// Lê o anexo do disco para reenviar pelo WhatsApp. Só arquivos da própria unidade (resolverArquivo).
function _arquivoDoAnexo(tenantId, anexo) {
  const nome = path.basename(String(anexo.url || ''));
  const full = mediaLib.resolverArquivo(tenantId, nome);
  if (!full) return null;
  return { buffer: fs.readFileSync(full), mimetype: anexo.mime, originalname: anexo.nome };
}

function _erroEnvio(out) {
  if (!out) return 'envio_falhou';
  if (out.notFound) return 'conversa_nao_encontrada';
  if (out.unsupported) return 'canal_nao_suportado';
  if (out.reason) return out.reason;
  return null;
}

// Envia a mensagem de boas-vindas. `texto` = o que a recepção deixou no campo (pode ter completado dia e
// horário). `comAnexo` = manda o arquivo da etapa junto (padrão). Trava contra envio duplo: a linha passa
// para 'aprovado' antes de ir para o WhatsApp; se o envio falhar, volta ao estado anterior.
// `auto` = envio da rotina automática (grava auto = true); `estados` = de onde a linha pode sair (a rotina
// só tira de 'pendente'; a recepção também completa e envia a bloqueada).
async function enviar(tenantId, toqueId, { texto, comAnexo = true, sender = 'RECEPCAO', auto = false, estados = ESTADOS_ABERTOS } = {}, deps = {}) {
  const inbox = deps.inbox || require('../routes/inbox');
  const atual = await detalhe(tenantId, toqueId);
  if (!atual) return { erro: 'mensagem_nao_encontrada', status: 404 };
  if (!atual.phone) return { erro: 'sem_telefone', status: 422 };

  const textoFinal = typeof texto === 'string' ? texto.trim() : atual.texto.trim();
  const anexo = comAnexo && atual.anexo ? atual.anexo : null;
  if (!textoFinal && !anexo) return { erro: 'mensagem_vazia', status: 422 };
  const arquivo = anexo ? _arquivoDoAnexo(tenantId, anexo) : null;
  if (anexo && !arquivo) return { erro: 'anexo_nao_encontrado', status: 422 };
  if (/\{[a-z][a-z0-9_]*\}/.test(textoFinal)) return { erro: 'texto_com_variavel_sem_valor', status: 422 };

  const reservado = await withTenant(tenantId, async (c) => (await c.query(
    `UPDATE lead_manager.boas_vindas_toque SET status = 'aprovado', bloqueio = NULL, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = ANY($3::text[]) RETURNING id`,
    [tenantId, toqueId, estados])).rows.length > 0);
  if (!reservado) return { erro: 'mensagem_ja_tratada', status: 409 };

  const voltar = async (erro) => {
    await withTenant(tenantId, (c) => c.query(
      `UPDATE lead_manager.boas_vindas_toque SET status = $3, bloqueio = $4, erro = $5, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status = 'aprovado'`,
      [tenantId, toqueId, atual.status, atual.bloqueio, String(erro).slice(0, 500)]));
    return { erro, status: 502 };
  };

  let conversationId = atual.conversationId;
  const enviados = [];
  try {
    if (!conversationId) {
      const conv = await withTenant(tenantId, (c) => inbox.ensureConversation(c, tenantId, atual.phone));
      if (!conv) return voltar('telefone_invalido');
      conversationId = conv.conversation_id;
    }
    const plano = R.planoDeEnvio({ texto: textoFinal, anexo: anexo ? { id: anexo.id, tipo: anexo.tipo } : null });
    for (const passo of plano) {
      let out;
      if (passo.kind === 'arquivo' && passo.tipo === 'audio') {
        out = await inbox.sendInboxAudio(tenantId, conversationId, arquivo, sender);
      } else if (passo.kind === 'arquivo') {
        out = await inbox.sendInboxMedia(tenantId, conversationId, arquivo, passo.legenda || '', sender);
      } else {
        out = await inbox.sendMessage(tenantId, conversationId, { text: passo.texto, sender });
      }
      const e = _erroEnvio(out);
      if (e) {
        if (!enviados.length) return voltar(e);
        // O arquivo já saiu e o texto não: a família recebeu parte. Registra como enviada, com o erro.
        await _marcarEnviado(tenantId, toqueId, { textoFinal, anexoId: anexo && anexo.id, erro: `texto não saiu: ${e}`, auto });
        return { ok: true, parcial: true, conversationId, erroTexto: e };
      }
      enviados.push(passo.kind);
    }
  } catch (err) {
    if (!enviados.length) return voltar(err.message || 'envio_falhou');
    await _marcarEnviado(tenantId, toqueId, { textoFinal, anexoId: anexo && anexo.id, erro: `envio incompleto: ${err.message}`, auto });
    return { ok: true, parcial: true, conversationId };
  }
  await _marcarEnviado(tenantId, toqueId, { textoFinal, anexoId: anexo && anexo.id, erro: null, auto });
  return { ok: true, conversationId, enviados };
}

async function _marcarEnviado(tenantId, toqueId, { textoFinal, anexoId, erro, auto = false }) {
  await withTenant(tenantId, (c) => c.query(
    `UPDATE lead_manager.boas_vindas_toque
        SET status = 'enviado', enviado_em = now(), bloqueio = NULL, texto_final = $3, anexo_id = $4, erro = $5, auto = $6, updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, toqueId, textoFinal, anexoId || null, erro, auto === true]));
}

async function descartar(tenantId, toqueId, { motivo, por } = {}) {
  const texto = String(motivo || '').trim().slice(0, 300) || 'descartada pela recepção';
  const ok = await withTenant(tenantId, async (c) => (await c.query(
    `UPDATE lead_manager.boas_vindas_toque SET status = 'descartado', bloqueio = NULL, motivo = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = ANY($4::text[]) RETURNING id`,
    [tenantId, toqueId, por ? `${texto} (${String(por).slice(0, 60)})` : texto, ESTADOS_ABERTOS])).rows.length > 0);
  return ok ? { ok: true } : { erro: 'mensagem_ja_tratada', status: 409 };
}

// ── Alertas de cliente que não começou (E17-05) ─────────────────────────────────────────────────
const SQL_ALERTAS = `
SELECT al.id, al.account_id, al.status, al.ini_vigencia::text AS ini_vigencia, al.dias, al.phone, al.destinatario_nome,
       al.cliente_nome, al.proximo_atendimento, al.criado_em, al.observacao, cv.id AS conversation_id
  FROM lead_manager.boas_vindas_alerta al
  JOIN lead_manager.automacao_config ac ON ac.tenant_id = al.tenant_id AND ac.boas_vindas_modo <> 'desligado'
  LEFT JOIN LATERAL (
    SELECT c.id FROM lead_manager.conversations c
     WHERE c.tenant_id = $1 AND c.channel = 'whatsapp' AND al.phone IS NOT NULL
       AND c.br_key = lead_manager.br_phone_key(al.phone)
     ORDER BY c.last_activity_at DESC NULLS LAST LIMIT 1
  ) cv ON true
 WHERE al.tenant_id = $1 AND al.status = 'aberto'
 ORDER BY al.dias DESC, al.criado_em
 LIMIT $2`;

function alertaDaLinha(r) {
  return {
    id: r.id, accountId: r.account_id, tipo: 'sem_primeiro_atendimento', status: r.status,
    iniVigencia: r.ini_vigencia, dias: r.dias, phone: r.phone, destinatarioNome: r.destinatario_nome,
    clienteNome: r.cliente_nome, proximoAtendimento: r.proximo_atendimento, criadoEm: r.criado_em,
    conversationId: r.conversation_id || null,
  };
}

async function listarAlertas(tenantId, { limite = 100 } = {}) {
  return withTenant(tenantId, async (c) => (await c.query(SQL_ALERTAS, [tenantId, Math.min(Math.max(1, limite | 0), 500)])).rows.map(alertaDaLinha));
}

// A recepção já falou com a família (ou sabe o motivo): o alerta sai da fila e não reabre.
async function dispensarAlerta(tenantId, alertaId, { observacao, por } = {}) {
  const ok = await withTenant(tenantId, async (c) => (await c.query(
    `UPDATE lead_manager.boas_vindas_alerta
        SET status = 'dispensado', resolvido_em = now(), resolvido_por = $3, observacao = $4, atualizado_em = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'aberto' RETURNING id`,
    [tenantId, alertaId, String(por || 'recepcao').slice(0, 80), String(observacao || '').trim().slice(0, 300) || null])).rows.length > 0);
  return ok ? { ok: true } : { erro: 'alerta_nao_encontrado', status: 404 };
}

module.exports = { listarFila, detalhe, enviar, descartar, MOTIVO_BLOQUEIO, SQL_FILA, listarAlertas, dispensarAlerta };
