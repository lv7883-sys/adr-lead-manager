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

// Telefone (dígitos) de um chat da Evolution. Duas formas de jid coexistem no store:
//   • <telefone>@s.whatsapp.net  → o próprio jid É o telefone.
//   • <lid>@lid                  → identificador de privacidade novo do WhatsApp; o telefone real
//     vem no key.remoteJidAlt de qualquer mensagem do chat. Sem alt → não dá p/ rotear (null).
// Grupos (@g.us) e sem telefone → null (ficam de fora do backfill 1:1).
function _telefoneDoChat(jid, records) {
  const s = String(jid || '');
  if (/@g\.us$/i.test(s)) return null;
  if (/@s\.whatsapp\.net$/i.test(s)) { const d = s.replace(/\D+/g, ''); return d || null; }
  if (/@lid$/i.test(s)) {
    for (const r of (records || [])) {
      const alt = r && r.key && r.key.remoteJidAlt;
      if (alt && /@s\.whatsapp\.net$/i.test(String(alt))) { const d = String(alt).replace(/\D+/g, ''); if (d) return d; }
    }
    return null;
  }
  const d = s.replace(/\D+/g, '');
  return d || null;
}

// Resolve o external_id CANÔNICO da conversa p/ o telefone (dígitos), espelhando engine.upsertConversation:
// casa uma conversa existente por br_phone_key (evita duplicata +55 vs 55, migr 094) e reusa o external_id
// dela; se não existe, devolve a forma canônica '55…' (mesma que o funil criaria). Assim o importarConversa
// (ON CONFLICT exato) casa a conversa certa ou cria a canônica — igual ao fluxo ao vivo.
async function _resolverExternalId(tenantId, dig, run) {
  return run(tenantId, async (c) => {
    const ex = (await c.query(
      `SELECT external_id FROM conversations
        WHERE tenant_id = $1 AND channel = 'whatsapp' AND br_phone_key(external_id) = br_phone_key($2)
        ORDER BY updated_at DESC LIMIT 1`, [tenantId, dig])).rows[0];
    if (ex) return ex.external_id;
    return dig.startsWith('55') ? dig : ((dig.length === 10 || dig.length === 11) ? `55${dig}` : dig);
  });
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

// Puxa o HISTÓRICO INTEIRO de um chat (paginando por where.key.remoteJid até acabar) e devolve os
// registros crus. Best-effort: nunca lança. Retorna { records, paginas, erro? }.
async function _puxarMensagens(evolution, creds, jid) {
  const records = []; let paginas = 0; let erro = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res;
    try { res = await evolution.findMessages(creds, jid, { page, pageSize: PAGE_SIZE }); }
    catch (e) { erro = e.message; break; }
    const reg = (res && Array.isArray(res.records)) ? res.records : [];
    paginas = page;
    if (!reg.length) break;
    records.push(...reg);
    // Para por metadados de páginas (a Evolution v2 expõe messages.pages) OU página incompleta.
    if (res.pages != null) { if (page >= res.pages) break; }
    else if (reg.length < (res.pageSize || PAGE_SIZE)) break;
  }
  return { records, paginas, erro };
}

// Backfill de UM chat da Evolution: pagina o histórico, deriva o telefone (cobre @lid via
// remoteJidAlt), resolve a conversa canônica (br_phone_key) e mescla via importarConversa
// (idempotente). Retorna { inseridos, pulados, paginas, erro? }.
async function backfillChat(tenantId, creds, chat, deps = {}) {
  const evolution = deps.evolution || evolutionDefault;
  const run = deps.withTenant || withTenant;
  const importar = deps.importarConversa || importarConversa;
  const jid = chat && (chat.remoteJid || chat.id || chat.jid);
  if (!jid || /@g\.us$/i.test(String(jid))) return { inseridos: 0, pulados: 0, paginas: 0 };

  const { records, paginas, erro } = await _puxarMensagens(evolution, creds, jid);
  if (erro && !records.length) return { inseridos: 0, pulados: 0, paginas, erro };
  if (!records.length) return { inseridos: 0, pulados: 0, paginas };

  const dig = _telefoneDoChat(jid, records);
  if (!dig) return { inseridos: 0, pulados: 0, paginas, erro: 'sem_telefone' };

  const msgs = records.map(mapEvolutionMsg).filter(Boolean);
  if (!msgs.length) return { inseridos: 0, pulados: 0, paginas };

  const externalId = await _resolverExternalId(tenantId, dig, run);
  const r = await importar(tenantId, { channel: 'whatsapp', externalId, msgs }, { withTenant: run });
  return { inseridos: r.inseridos || 0, pulados: r.pulados || 0, paginas, erro: r.erro || erro };
}

// Backfill de UM tenant. Confirma 'open' (a queda pode ter voltado a cair). Itera os CHATS da
// própria Evolution (findChats = fonte de verdade dos jids reais, inclusive @lid). `deep`
// (reconexão) = TODOS os chats; senão = só os com atividade na janela (safety-net). Cada chat é
// paginado por INTEIRO. Atualiza wa_sync_state.last_sync_at ao fim.
// Retorna { skipped? , state?, chats, inseridos, erros }.
async function backfillTenant(tenantId, opts = {}, deps = {}) {
  const evolution = deps.evolution || evolutionDefault;
  const run = deps.withTenant || withTenant;
  const getCreds = deps.credsForTenant || credsForTenant;

  const creds = await getCreds(tenantId);
  if (!creds || !creds.instance || !creds.apikey) return { skipped: 'sem_evolution', chats: 0, inseridos: 0, erros: 0 };

  let st;
  try { st = await evolution.status({ instance: creds.instance, apikey: creds.apikey }); }
  catch (e) { return { skipped: 'status_falhou', detail: e.message, chats: 0, inseridos: 0, erros: 0 }; }
  if (!st || st.state !== 'open') return { skipped: 'nao_open', state: st && st.state, chats: 0, inseridos: 0, erros: 0 };

  let chats;
  try { chats = await evolution.findChats({ instance: creds.instance, apikey: creds.apikey }); }
  catch (e) { return { skipped: 'findchats_falhou', detail: e.message, chats: 0, inseridos: 0, erros: 0 }; }

  const deep = !!opts.deep;
  const limite = opts.limite || (deep ? DEEP_LIMIT_CONVERSAS : SHALLOW_LIMIT_CONVERSAS);
  const windowDays = opts.windowDays || SHALLOW_WINDOW_DAYS;
  const corte = deep ? 0 : (Date.now() - windowDays * 86400 * 1000);

  // 1:1 só (grupos fora). No shallow, filtra por updatedAt do chat (a própria Evolution já dá).
  let alvos = (Array.isArray(chats) ? chats : []).filter((ch) => {
    const jid = ch && (ch.remoteJid || ch.id || ch.jid);
    if (!jid || /@g\.us$/i.test(String(jid))) return false;
    if (deep) return true;
    const up = ch.updatedAt ? Date.parse(ch.updatedAt) : NaN;
    return Number.isNaN(up) ? true : up >= corte;   // sem data → inclui (conservador)
  });
  if (alvos.length > limite) alvos = alvos.slice(0, limite);

  let inseridos = 0; let erros = 0; let ultimoErro = null;
  for (const chat of alvos) {
    const r = await backfillChat(tenantId, { instance: creds.instance, apikey: creds.apikey }, chat, deps);
    inseridos += r.inseridos;
    if (r.erro && r.erro !== 'sem_telefone') { erros += 1; ultimoErro = r.erro; }
  }
  await _gravarEstado(tenantId, { last_sync_at: new Date(), last_error: ultimoErro }, run);
  logger.info('wa_sync.backfill_tenant', { tenant_id: tenantId, deep, chats: alvos.length, inseridos, erros });
  return { state: 'open', chats: alvos.length, inseridos, erros, ultimoErro };
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
  backfillTenant, backfillChat, syncReconnections, handleConnectionUpdate,
  _telefoneDoChat, _resolverExternalId, _estadoDoConnectionUpdate,
};
