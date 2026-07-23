'use strict';
//
// plantao.js — PLANTÃO diário (ADR-040). AGREGA o que já é gravado (bola_shadow_log,
// gate_shadow_log + messages.discarded, reabordagem_tentativas, cadastro_sync_log) num resumo
// por sistema com semáforo verde/amarelo/vermelho + números do dia. NÃO cria captura nova —
// só leitura de log. Usado pelo card do dashboard E pelo cron do resumo noturno. Multi-tenant
// (recebe tenantId; sem hardcode). Custo: ~6 SELECTs de contagem por tenant, 1x/dia (+ o card).
//
const { withTenant } = require('./db');
const { retomadaLateral, reengajouExists } = require('./reativacao');   // #8 Fatia B: fonte única da retomada

async function _safe(fn, def) { try { return await fn(); } catch { return def; } }
// #8 Fatia B — "hoje" em America/Sao_Paulo (antes era UTC → "hoje" do card divergia ~3h do
// resto do produto, que usa SP). Aplica a TODAS as linhas do plantão (bola/filtro/reativação/...).
const HOJE = "date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'";

// resumoPlantao(tenantId) → { gerado_em, pior, systems: [{key,label,status,numeros,detalhe,link}] }
// status ∈ 'verde'|'amarelo'|'vermelho'. link = destino RELATIVO (o dashboard prefixa /f/:slug).
async function resumoPlantao(tenantId) {
  return withTenant(tenantId, async (c) => {
    const systems = [];
    const push = (s) => systems.push(s);

    // ---- BOLA (ADR-030) ----
    const bola = await _safe(async () => {
      const n = (await c.query(`SELECT count(*)::int n FROM lead_manager.bola_shadow_log
        WHERE tenant_id=$1 AND camada<>'skip' AND created_at >= ${HOJE}`, [tenantId])).rows[0].n;
      const rev = (await c.query(`SELECT count(*)::int n FROM lead_manager.field_provenance
        WHERE tenant_id=$1 AND entity_kind='lead' AND field='conversation_state' AND locked_at >= ${HOJE}`, [tenantId])).rows[0].n;
      const mode = (await c.query(`SELECT bola_mode FROM lead_manager.tenant_lead_config WHERE tenant_id=$1`, [tenantId])).rows[0];
      return { n, rev, mode: (mode && mode.bola_mode) || 'off' };
    }, null);
    if (bola) push({ key: 'bola', label: 'Bola', status: 'verde',
      numeros: `${bola.n} decisões · ${bola.rev} revertidas`,
      detalhe: bola.mode === 'on' ? 'governa o estado' : 'observando (shadow)', link: '/monitor-filtro' });

    // ---- FILTRO (gate por papel, ADR-036) ----
    const filtro = await _safe(async () => {
      const g = (await c.query(`SELECT count(*)::int total, count(*) FILTER (WHERE would_action='hard' AND crivo_outcome='lead')::int fp
        FROM lead_manager.gate_shadow_log WHERE tenant_id=$1 AND role_id IS NOT NULL AND created_at >= ${HOJE}`, [tenantId])).rows[0];
      const desc = (await c.query(`SELECT count(*)::int n FROM lead_manager.messages
        WHERE tenant_id=$1 AND discarded AND discard_reason='role_hard' AND received_at >= ${HOJE}`, [tenantId])).rows[0].n;
      const rev = (await c.query(`SELECT count(*)::int n FROM lead_manager.classification_feedback
        WHERE tenant_id=$1 AND correction_context LIKE 'gate_revert%' AND feedback_at >= ${HOJE}`, [tenantId])).rows[0].n;
      return { total: g.total, fp: g.fp, descartes: desc, rev };
    }, null);
    if (filtro) push({ key: 'filtro', label: 'Filtro', status: filtro.fp > 0 ? 'amarelo' : 'verde',
      numeros: `${filtro.descartes} descartes · ${filtro.rev} revertidos`,
      detalhe: filtro.fp > 0 ? `⚠ ${filtro.fp} teria(m) engolido lead` : `${filtro.total} decisões-sombra`, link: '/monitor-filtro' });

    // ---- REATIVAÇÃO (ADR-027, RE-FONTEADO #8 Fatia B) ----
    // Retomada = saída nossa após silêncio >= dormancy_days (helper, MESMA regra do /leads e do BI).
    // "enviadas" = leads cuja última retomada foi HOJE (SP); "reengajaram" = reabordados que
    // receberam inbound HOJE após a retomada. Fonte antiga (reabordagem_tentativas) abandonada —
    // ela nunca gravava 'enviado' (as retomadas reais saem via /approve → invisíveis a ela).
    const reat = await _safe(async () => {
      const dorm = (await c.query(`SELECT dormancy_days FROM lead_manager.tenant_lead_config WHERE tenant_id=$1`, [tenantId])).rows[0];
      const N = Number.isInteger(dorm?.dormancy_days) && dorm.dormancy_days > 0 ? dorm.dormancy_days : 7;
      return (await c.query(
        `SELECT
           count(*) FILTER (WHERE rtm.retomada_em IS NOT NULL AND rtm.retomada_em >= ${HOJE})::int enviadas,
           count(*) FILTER (WHERE rtm.retomada_em IS NOT NULL
                              AND ${reengajouExists('rtm.retomada_em', { schema: 'lead_manager.', since: HOJE })})::int reengajaram
           FROM lead_manager.leads l
           ${retomadaLateral('$2', { schema: 'lead_manager.' })}
          WHERE l.tenant_id=$1 AND l.status NOT IN ('NOT_LEAD','REVIEW_QUEUE')`,
        [tenantId, N])).rows[0];
    }, null);
    if (reat) push({ key: 'reativacao', label: 'Reativação', status: 'verde',
      numeros: `${reat.enviadas} retomadas · ${reat.reengajaram} reengajaram`, detalhe: '', link: '/reativacao' });

    // ---- CADASTRO SYNC (cron diário, ADR-037) ----
    const cad = await _safe(async () => (await c.query(
      `SELECT status, duration_ms, stats, error_kind, finished_at,
              (now() - finished_at) > interval '26 hours' AS stale
         FROM lead_manager.cadastro_sync_log WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1`, [tenantId])).rows[0] || null, null);
    if (!cad) {
      // "nunca rodou" NÃO é problema (o 1º run é o 04h natural) → CINZA/neutro, não amarelo.
      push({ key: 'cadastro_sync', label: 'Cadastro sync', status: 'cinza', numeros: 'ainda não rodou', detalhe: '1º run às 04h', link: null });
    } else {
      const st = cad.status === 'ERROR' || cad.error_kind === 'CREDENTIAL' ? 'vermelho'
        : cad.status === 'SAFEGUARD' || cad.stale ? 'amarelo' : 'verde';
      const s = cad.stats || {};
      push({ key: 'cadastro_sync', label: 'Cadastro sync', status: st,
        numeros: `${s.contratos_novos || 0} novos · ${s.atualizados || 0} mudados · ${s.soft_deleted || 0} sumidos`,
        detalhe: cad.status === 'OK' ? `ok · ${Math.round((cad.duration_ms || 0) / 1000)}s` : `${cad.status}${cad.error_kind ? ' (' + cad.error_kind + ')' : ''}`, link: null });
    }

    // ---- INGESTÃO / SCRAPE: última falha de login/block (dos syncs de Extranet) ----
    const scr = await _safe(async () => (await c.query(
      `SELECT error_kind, error, finished_at FROM lead_manager.cadastro_sync_log
        WHERE tenant_id=$1 AND status IN ('ERROR','SAFEGUARD') AND finished_at >= now() - interval '48 hours'
        ORDER BY created_at DESC LIMIT 1`, [tenantId])).rows[0], null);
    if (scr) push({ key: 'scrape', label: 'Scrape', status: scr.error_kind === 'CREDENTIAL' ? 'vermelho' : 'amarelo',
      numeros: `falha ${scr.error_kind || '?'}`, detalhe: String(scr.error || '').slice(0, 60), link: null });
    else push({ key: 'scrape', label: 'Scrape', status: 'verde', numeros: 'sem falha (48h)', detalhe: '', link: null });

    // 'cinza' (neutro) NÃO escala o pior — "não rodou" não é alerta.
    const ordem = { cinza: 0, verde: 0, amarelo: 1, vermelho: 2 };
    const pior = systems.reduce((p, s) => ((ordem[s.status] || 0) > ordem[p] ? s.status : p), 'verde');
    return { gerado_em: new Date().toISOString(), pior, systems };
  });
}

module.exports = { resumoPlantao };
