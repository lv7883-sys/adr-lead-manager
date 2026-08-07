'use strict';
//
// waSync.js — RECONEXÃO: backfill do histórico do WhatsApp quando a instância volta ao ar.
//
// CONTEXTO. O Regente recebe mensagens por webhook (push, ao vivo). Quando a instância Evolution
// cai e a recepção continua a conversa em OUTRA plataforma (WhatsApp Web / celular), as respostas
// dela (fromMe=true) chegam ao Baileys por history-sync na reconexão — que a Evolution NÃO
// reencaminha como messages.upsert. Sem este módulo, essas mensagens somem (conversa truncada).
//
// O QUE FAZ. Detecta a transição do estado da conexão para 'open' (via cron de polling E, quando
// disponível, via webhook connection.update) e PUXA as mensagens do store da própria Evolution
// (evolution.findMessages), mesclando na timeline com importHistorico.importarConversa — que é
// idempotente (dedup por external_message_id) e SÓ importa histórico: NÃO roda funil/IA, NÃO cria
// lead, NÃO reabre a Janis. As mensagens aparecem em Leads e na Caixa de Entrada, e o cursor de
// leitura avança (não infla o badge de não-lidas). A IA/funil só entram quando a conversa é
// RETOMADA por uma mensagem NOVA (fluxo normal do webhook).
//
const { pool, withTenant } = require('./db');
const logger = require('./logger');
const evolutionDefault = require('./evolution');
const { credsForTenant } = require('./outbound');
const { mapEvolutionMsg, importarConversa } = require('./importHistorico');

// DEEP (reconexão) = varre TODAS as conversas do tenant (sem janela de tempo) e puxa o HISTÓRICO
// INTEIRO de cada uma — garantia de "100% atualizado". SHALLOW (safety-net periódico) = mesma
// paginação completa por conversa, mas só nas conversas com atividade recente (mantém o custo baixo
// entre reconexões). Tetos defensivos (env) só p/ evitar loop infinito em caso patológico.
const SHALLOW_WINDOW_DAYS = Number(process.env.WA_SYNC_SHALLOW_DAYS || 3);
const DEEP_LIMIT_CONVERSAS = Number(process.env.WA_SYNC_DEEP_LIMIT || 100000);   // ~todas
const SHALLOW_LIMIT_CONVERSAS = Number(process.env.WA_SYNC_SHALLOW_LIMIT || 2000);
// Paginação do histórico por conversa: tamanho da página e teto de páginas (backstop anti-loop;
// 500 × 200 = 100k msgs/conversa, folga enorme). O padrão é puxar TUDO até a Evolution não ter mais.
const PAGE_SIZE = Number(process.env.WA_SYNC_PAGE_SIZE || 200);
const MAX_PAGES = Number(process.env.WA_SYNC_MAX_PAGES || 500);
// Safety-net: se a instância está 'open' mas o último sync foi há mais que isso, roda shallow.
const SAFETY_NET_HOURS = Number(process.env.WA_SYNC_SAFETY_HOURS || 6);

// external_id (telefone cru / jid) -> remoteJid do WhatsApp. Grupos (@g.us) ficam de fora deste
// backfill (foco no 1:1 do lead) -> null. Sem dígitos -> null.
function _remoteJid(externalId) {
  const s = String(externalId || '');
  if (/@g\.us$/i.test(s)) return null;
  const digits = s.replace(/\D+/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

// Lê o estado guardado da conexão do tenant (wa_sync_state). Null se ainda não há linha.
async function _lerEstado(tenantId, run) {
  return run(tenantId, async (c) => (await c.query(
    'SELECT last_state, last_state_at, last_reconnect_at, last_sync_at FROM wa_sync_state WHERE tenant_id = $1',
    [tenantId])).rows[0] || null);
}

// Grava (upsert) campos do estado. `patch` = objeto com colunas a setar; sempre bumpa updated_at.
async function _gravarEstado(tenantId, patch, run) {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const setList = cols.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const insCols = ['tenant_id', ...cols].join(', ');
  const insVals = ['$1', ...cols.map((_, i) => `$${i + 2}`)].join(', ');
  const vals = [tenantId, ...cols.map((k) => patch[k])];
  await run(tenantId, (c) => c.query(
    `INSERT INTO wa_sync_state (${insCols}, updated_at) VALUES (${insVals}, now())
     ON CONFLICT (tenant_id) DO UPDATE SET ${setList}, updated_at = now()`,
    vals));
}

// TODAS as conversas de WhatsApp do tenant (deep/reconexão). Grupos fora. Teto só anti-patológico.
// Ordena pela mais recente (as que mais provavelmente truncaram primeiro).
async function _todasConversas(tenantId, limite, run) {
  return run(tenantId, async (c) => (await c.query(
    `SELECT c.id, c.external_id
       FROM conversations c
      WHERE c.tenant_id = $1 AND c.channel = 'whatsapp' AND c.external_id NOT LIKE '%@g.us'
      ORDER BY c.updated_at DESC
      LIMIT $2`,
    [tenantId, limite])).rows);
}

// Conversas de WhatsApp com atividade dentro da janela (inbound, saída OU criação recente) —
// usado só no safety-net periódico (shallow). Grupos fora. Ordena pela mais recente.
async function _conversasAtivas(tenantId, windowDays, limite, run) {
  return run(tenantId, async (c) => (await c.query(
    `SELECT c.id, c.external_id
       FROM conversations c
      WHERE c.tenant_id = $1
        AND c.channel = 'whatsapp'
        AND c.external_id NOT LIKE '%@g.us'
        AND (
          c.created_at > now() - make_interval(days => $2::int)
          OR EXISTS (SELECT 1 FROM messages m
                      WHERE m.conversation_id = c.id
                        AND m.received_at > now() - make_interval(days => $2::int))
          OR EXISTS (SELECT 1 FROM staff_outbound_samples s
                      WHERE s.tenant_id = c.tenant_id AND s.external_id = c.external_id
                        AND s.received_at > now() - make_interval(days => $2::int))
        )
      ORDER BY c.updated_at DESC
      LIMIT $3`,
    [tenantId, windowDays, limite])).rows);
}

// Puxa o histórico INTEIRO de UMA conversa da Evolution (pagina página a página até acabar) e
// mescla idempotentemente. Passa o external_id JÁ ARMAZENADO na conversa (não o jid recomposto)
// p/ o ON CONFLICT casar a conversa existente — evita recriar duplicata (+55 vs 55, ver migr 094).
// Best-effort: nunca lança. Retorna { inseridos, pulados, paginas, erro? }.
async function backfillConversa(tenantId, creds, conv, deps = {}) {
  const evolution = deps.evolution || evolutionDefault;
  const run = deps.withTenant || withTenant;
  const importar = deps.importarConversa || importarConversa;
  const remoteJid = _remoteJid(conv.external_id);
  if (!remoteJid) return { inseridos: 0, pulados: 0, paginas: 0 };

  let inseridos = 0; let pulados = 0; let paginas = 0; let ultimoErro = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res;
    try {
      res = await evolution.findMessages(creds, remoteJid, { page, pageSize: PAGE_SIZE });
    } catch (e) { ultimoErro = e.message; break; }
    const registros = (res && Array.isArray(res.records)) ? res.records : [];
    paginas = page;
    if (!registros.length) break;                 // acabou o histórico
    const msgs = registros.map(mapEvolutionMsg).filter(Boolean);
    if (msgs.length) {
      const r = await importar(tenantId, { channel: 'whatsapp', externalId: conv.external_id, msgs }, { withTenant: run });
      inseridos += r.inseridos || 0; pulados += r.pulados || 0;
      if (r.erro) ultimoErro = r.erro;
    }
    // Condições de parada: metadados de páginas (quando a versão os expõe) OU página incompleta
    // (menos registros que o tamanho da página = era a última). Assim puxamos TUDO, sem "últimas X".
    if (res.pages != null) { if (page >= res.pages) break; }
    else if (registros.length < PAGE_SIZE) break;
  }
  return { inseridos, pulados, paginas, erro: ultimoErro };
}

// Backfill de UM tenant. Confirma 'open' (a queda pode ter voltado a cair) e mescla. `deep`
// (reconexão) = TODAS as conversas; senão = só as ativas na janela (safety-net). Cada conversa é
// paginada por INTEIRO. Atualiza wa_sync_state.last_sync_at ao fim.
// Retorna { skipped? , state?, conversas, inseridos, erros }.
async function backfillTenant(tenantId, opts = {}, deps = {}) {
  const evolution = deps.evolution || evolutionDefault;
  const run = deps.withTenant || withTenant;
  const getCreds = deps.credsForTenant || credsForTenant;

  const creds = await getCreds(tenantId);
  if (!creds || !creds.instance || !creds.apikey) return { skipped: 'sem_evolution', conversas: 0, inseridos: 0, erros: 0 };

  let st;
  try { st = await evolution.status({ instance: creds.instance, apikey: creds.apikey }); }
  catch (e) { return { skipped: 'status_falhou', detail: e.message, conversas: 0, inseridos: 0, erros: 0 }; }
  if (!st || st.state !== 'open') return { skipped: 'nao_open', state: st && st.state, conversas: 0, inseridos: 0, erros: 0 };

  const deep = !!opts.deep;
  // DEEP = TODAS as conversas (reconexão: garante 100%); SHALLOW = só as ativas na janela.
  const convs = deep
    ? await _todasConversas(tenantId, opts.limite || DEEP_LIMIT_CONVERSAS, run)
    : await _conversasAtivas(tenantId, opts.windowDays || SHALLOW_WINDOW_DAYS, opts.limite || SHALLOW_LIMIT_CONVERSAS, run);

  let inseridos = 0; let erros = 0; let ultimoErro = null;
  for (const conv of convs) {
    const r = await backfillConversa(tenantId, { instance: creds.instance, apikey: creds.apikey }, conv, deps);
    inseridos += r.inseridos;
    if (r.erro) { erros += 1; ultimoErro = r.erro; }
  }
  await _gravarEstado(tenantId, { last_sync_at: new Date(), last_error: ultimoErro }, run);
  logger.info('wa_sync.backfill_tenant', { tenant_id: tenantId, deep, conversas: convs.length, inseridos, erros });
  return { state: 'open', conversas: convs.length, inseridos, erros, ultimoErro };
}

// Ciclo do cron: p/ cada tenant ativo, lê o status, detecta transição -> 'open' (reconexão) e
// dispara o backfill profundo; senão, roda o safety-net raso se o último sync está velho. Sempre
// atualiza o estado observado. deps injetáveis p/ teste.
async function syncReconnections(deps = {}) {
  const q = deps.pool || pool;
  const evolution = deps.evolution || evolutionDefault;
  const run = deps.withTenant || withTenant;
  const getCreds = deps.credsForTenant || credsForTenant;

  const tenants = (await q.query('SELECT tenant_id FROM tenants_active()')).rows;
  const resumo = { tenants: tenants.length, reconexoes: 0, safety: 0, inseridos: 0 };

  for (const t of tenants) {
    const tenantId = t.tenant_id;
    try {
      const creds = await getCreds(tenantId);
      if (!creds || !creds.instance || !creds.apikey) continue;

      let st;
      try { st = await evolution.status({ instance: creds.instance, apikey: creds.apikey }); }
      catch (e) { logger.warn('wa_sync.status_falhou', { tenant_id: tenantId, error: e.message }); continue; }
      const estadoAtual = (st && st.state) || 'unknown';

      const prev = await _lerEstado(tenantId, run);
      const estadoAnterior = prev && prev.last_state;
      // Transição p/ 'open' vindo de um estado NÃO-open conhecido = reconexão. Se não há estado
      // anterior (1ª observação após o deploy), NÃO tratamos como reconexão (evita backfill em
      // massa no boot) — o safety-net abaixo cuida do heal inicial de forma mais leve.
      const reconectou = estadoAtual === 'open' && estadoAnterior && estadoAnterior !== 'open';

      await _gravarEstado(tenantId, { last_state: estadoAtual, last_state_at: new Date() }, run);

      if (reconectou) {
        await _gravarEstado(tenantId, { last_reconnect_at: new Date() }, run);
        const r = await backfillTenant(tenantId, { deep: true }, deps);
        resumo.reconexoes += 1; resumo.inseridos += (r.inseridos || 0);
        logger.info('wa_sync.reconexao', { tenant_id: tenantId, de: estadoAnterior, inseridos: r.inseridos });
        continue;
      }

      if (estadoAtual === 'open') {
        const ultimoSync = prev && prev.last_sync_at ? new Date(prev.last_sync_at) : null;
        const velho = !ultimoSync || (Date.now() - ultimoSync.getTime()) > SAFETY_NET_HOURS * 3600 * 1000;
        if (velho) {
          const r = await backfillTenant(tenantId, { deep: false }, deps);
          resumo.safety += 1; resumo.inseridos += (r.inseridos || 0);
        }
      }
    } catch (err) {
      logger.error('wa_sync.tenant_error', { tenant_id: tenantId, error: err.message });
    }
  }
  logger.info('wa_sync.done', resumo);
  return resumo;
}

// Caminho INSTANTÂNEO (opcional): o webhook connection.update chegou. Extrai o estado; numa
// transição p/ 'open' (o estado guardado não era 'open') dispara o backfill profundo na hora.
// Debounce pelo estado guardado: heartbeats repetidos de 'open' NÃO re-disparam. Best-effort.
function _estadoDoConnectionUpdate(body) {
  const d = (body && body.data) || body || {};
  return d.state || d.connection || d.status || (body && body.state) || null;
}

async function handleConnectionUpdate(tenantId, body, deps = {}) {
  const run = deps.withTenant || withTenant;
  const estado = _estadoDoConnectionUpdate(body);
  if (!estado) return { ignored: true };
  const prev = await _lerEstado(tenantId, run);
  const anterior = prev && prev.last_state;
  await _gravarEstado(tenantId, { last_state: estado, last_state_at: new Date() }, run);
  if (estado === 'open' && anterior !== 'open') {
    await _gravarEstado(tenantId, { last_reconnect_at: new Date() }, run);
    const r = await backfillTenant(tenantId, { deep: true }, deps);
    logger.info('wa_sync.reconexao_webhook', { tenant_id: tenantId, de: anterior || 'desconhecido', inseridos: r.inseridos });
    return { reconnected: true, inseridos: r.inseridos };
  }
  return { reconnected: false, state: estado };
}

module.exports = {
  backfillTenant, backfillConversa, syncReconnections, handleConnectionUpdate,
  _remoteJid, _estadoDoConnectionUpdate,
};
