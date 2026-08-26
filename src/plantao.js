'use strict';
//
// plantao.js — PLANTÃO diário (ADR-040). AGREGA o que já é gravado (bola_shadow_log,
// gate_shadow_log + messages.discarded, reabordagem_tentativas, cadastro_sync_log) num resumo
// por sistema com semáforo verde/amarelo/vermelho + números do dia. NÃO cria captura nova —
// só leitura de log. Usado pelo card do dashboard E pelo cron do resumo noturno. Multi-tenant
// (recebe tenantId; sem hardcode). Custo: ~6 SELECTs de contagem por tenant, 1x/dia (+ o card).
//
const { withTenant } = require('./db');
const { retomadaCtes, identLateral } = require('./reativacao');   // #8 Fatia B: fonte única da retomada (forma em janela)

// ------------------------------------------------------------------------------------------------
// VOCABULÁRIO DE ESTADO (auditoria de indicadores 2026-08-26). O card existe pra dizer se o sistema
// está de pé; ele não pode responder "está tudo bem" quando a resposta honesta é "não sei".
//
//   cinza    = NÃO HÁ O QUE AVALIAR — desligado, sem atividade hoje, não rodou, consulta falhou,
//              ou fato estruturalmente não verificável. NÃO escala o `pior` (não é alarme).
//   verde    = RODOU e está bem. Nunca é o default: exige atividade observada.
//   amarelo  = anomalia que merece olhada.
//   vermelho = quebrou.
//
// A regra que isto corrige, repetida em quase todas as linhas: ausência de dado era renderizada
// como estado bom (verde literal ignorando os números; zeros inventados quando a coleta falhou;
// silêncio de 48h virando "sem falha"), e falha de consulta fazia a linha SUMIR sem alterar o
// contador "N precisam de olho" — falha silenciosa dentro da própria ferramenta de observabilidade.
// ------------------------------------------------------------------------------------------------

// Sentinela de FALHA da consulta — distinta de `null`, que em alguns itens significa "não rodou
// ainda" (um fato legítimo). Sem essa distinção a linha sumia do card.
const FALHOU = Object.freeze({ __falhou: true });
async function _safe(fn, def) { try { return await fn(); } catch { return def; } }
const _indisponivel = (key, label) => ({
  key, label, status: 'cinza', numeros: 'indisponível',
  detalhe: 'a consulta deste item falhou — o número não é zero, é desconhecido', link: null,
});
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
    }, FALHOU);
    if (bola === FALHOU) push(_indisponivel('bola', 'Bola'));
    else if (bola) push({ key: 'bola', label: 'Bola',
      // Era 'verde' LITERAL, ignorando os números: "0 decisões" e "tudo saudável" ficavam idênticos
      // na tela, e o card não sabia dizer se a Bola parou de decidir porque não houve saída da
      // recepção ou porque o classificador quebrou.
      status: bola.mode === 'off' ? 'cinza' : ((bola.n === 0 && bola.rev === 0) ? 'cinza' : 'verde'),
      numeros: bola.mode === 'off' ? 'desligada' : `${bola.n} decisões · ${bola.rev} revertidas`,
      detalhe: bola.mode === 'on' ? 'governa o estado' : (bola.mode === 'off' ? 'não avalia nada' : 'observando (shadow)'),
      link: '/monitor-filtro' });

    // ---- FILTRO (gate por papel, ADR-036) ----
    const filtro = await _safe(async () => {
      const g = (await c.query(`SELECT count(*)::int total, count(*) FILTER (WHERE would_action='hard' AND crivo_outcome='lead')::int fp
        FROM lead_manager.gate_shadow_log WHERE tenant_id=$1 AND role_id IS NOT NULL AND created_at >= ${HOJE}`, [tenantId])).rows[0];
      const desc = (await c.query(`SELECT count(*)::int n FROM lead_manager.messages
        WHERE tenant_id=$1 AND discarded AND discard_reason='role_hard' AND received_at >= ${HOJE}`, [tenantId])).rows[0].n;
      const rev = (await c.query(`SELECT count(*)::int n FROM lead_manager.classification_feedback
        WHERE tenant_id=$1 AND correction_context LIKE 'gate_revert%' AND feedback_at >= ${HOJE}`, [tenantId])).rows[0].n;
      const cfg = (await c.query(
        `SELECT gate_suppression_mode FROM lead_manager.tenant_lead_config WHERE tenant_id=$1`, [tenantId])).rows[0];
      const modo = ['off', 'shadow', 'on'].includes(cfg && cfg.gate_suppression_mode) ? cfg.gate_suppression_mode : 'off';
      return { total: g.total, fp: g.fp, descartes: desc, rev, modo };
    }, FALHOU);
    if (filtro === FALHOU) push(_indisponivel('filtro', 'Filtro'));
    else if (filtro) {
      // ⚠ `fp` (would_action='hard' AND crivo_outcome='lead') é INALCANÇÁVEL no modo 'on': o engine
      // faz `return` logo após captureDiscarded (engine.js), ANTES do _shadowOutcome que grava
      // crivo_outcome. Ou seja, exatamente as mensagens REALMENTE descartadas nunca recebem o
      // carimbo — fp é sempre 0 justamente no modo em que o gate causa dano. O card ficava VERDE
      // com descartes reais na tela. Rodar o crivo só pra auditar custaria uma chamada de IA por
      // mensagem descartada, então aqui a saída é não MENTIR: no modo 'on' o falso-positivo é
      // declarado não verificável, e o sinal que vale passa a ser o REVERT (prova humana).
      const houve = filtro.total > 0 || filtro.descartes > 0 || filtro.rev > 0;
      const rotuloDecisoes = filtro.modo === 'on'
        ? `${filtro.total} decisões (gate ligado)`   // não são "sombra": viraram ação
        : `${filtro.total} decisões-sombra`;
      let status, detalhe;
      if (filtro.rev > 0) {
        status = 'amarelo';
        detalhe = `⚠ ${filtro.rev} revertido(s) hoje — o filtro tirou lead do funil`;
      } else if (filtro.fp > 0) {
        status = 'amarelo';
        detalhe = `⚠ ${filtro.fp} teria(m) engolido lead`;
      } else if (!houve) {
        status = 'cinza';
        detalhe = filtro.modo === 'off' ? 'desligado' : 'nenhuma decisão hoje';
      } else if (filtro.modo === 'on' && filtro.descartes > 0) {
        status = 'cinza';
        detalhe = `${rotuloDecisoes} · falso-positivo não verificável com o gate ligado`;
      } else {
        status = 'verde';
        detalhe = rotuloDecisoes;
      }
      push({ key: 'filtro', label: 'Filtro', status,
        numeros: `${filtro.descartes} descartes · ${filtro.rev} revertidos`,
        detalhe, link: '/monitor-filtro' });
    }

    // ---- REATIVAÇÃO (ADR-027, RE-FONTEADO #8 Fatia B) ----
    // Retomada = saída nossa após silêncio >= dormancy_days (helper, MESMA regra do /leads e do BI).
    // "enviadas" = leads cuja última retomada foi HOJE (SP); "reengajaram" = reabordados que
    // receberam inbound HOJE após a retomada. Fonte antiga (reabordagem_tentativas) abandonada —
    // ela nunca gravava 'enviado' (as retomadas reais saem via /approve → invisíveis a ela).
    const reat = await _safe(async () => {
      const dorm = (await c.query(`SELECT dormancy_days FROM lead_manager.tenant_lead_config WHERE tenant_id=$1`, [tenantId])).rows[0];
      const N = Number.isInteger(dorm?.dormancy_days) && dorm.dormancy_days > 0 ? dorm.dormancy_days : 7;
      // reengajou HOJE: rin.last_in > retomada E >= HOJE (max satisfaz sse existe inbound assim).
      return (await c.query(
        `WITH ${retomadaCtes('$2', { schema: 'lead_manager.' })}
         SELECT
           count(*) FILTER (WHERE rtm.retomada_em IS NOT NULL AND rtm.retomada_em >= ${HOJE})::int enviadas,
           count(*) FILTER (WHERE rtm.retomada_em IS NOT NULL
                              AND rin.last_in > rtm.retomada_em AND rin.last_in >= ${HOJE})::int reengajaram
           FROM lead_manager.leads l
           ${identLateral('l')}
           LEFT JOIN rt_retom rtm ON li.ident <> '' AND rtm.ident = li.ident
           LEFT JOIN rt_in   rin ON li.ident <> '' AND rin.ident = li.ident
          WHERE l.tenant_id=$1 AND l.status NOT IN ('NOT_LEAD','REVIEW_QUEUE')`,
        [tenantId, N])).rows[0];
    }, FALHOU);
    if (reat === FALHOU) push(_indisponivel('reativacao', 'Reativação'));
    else if (reat) push({ key: 'reativacao', label: 'Reativação',
      // idem Bola: era verde literal. Sem retomada nenhuma hoje não é "saudável", é "nada aconteceu".
      status: (reat.enviadas === 0 && reat.reengajaram === 0) ? 'cinza' : 'verde',
      numeros: `${reat.enviadas} retomadas · ${reat.reengajaram} reengajaram`,
      detalhe: (reat.enviadas === 0 && reat.reengajaram === 0) ? 'nenhuma retomada hoje' : '',
      link: '/reativacao' });

    // ---- CADASTRO SYNC (cron diário, ADR-037) ----
    const cad = await _safe(async () => (await c.query(
      `SELECT id, status, duration_ms, stats, error_kind, finished_at,
              (now() - finished_at) > interval '26 hours' AS stale
         FROM lead_manager.cadastro_sync_log WHERE tenant_id=$1 AND kind='SCRAPE_EXTRANET'
        ORDER BY created_at DESC LIMIT 1`, [tenantId])).rows[0] || null, FALHOU);
    // ⚠ kind: a 102 passou a gravar TAMBÉM kind='SCRAPE_EXTRANET_LEADS' (5 runs/dia) nesta tabela;
    // sem o filtro, este card leria o run de LEADS como se fosse o de cadastro (stats erradas +
    // stale de 26h nunca dispararia). O card 'Scrape' abaixo segue SEM filtro de propósito
    // (falha de login/block de QUALQUER sync da Extranet deve aparecer lá).
    if (cad === FALHOU) {
      push(_indisponivel('cadastro_sync', 'Cadastro sync'));
    } else if (!cad) {
      // "nunca rodou" NÃO é problema (o 1º run é o 04h natural) → CINZA/neutro, não amarelo.
      push({ key: 'cadastro_sync', label: 'Cadastro sync', status: 'cinza', numeros: 'ainda não rodou', detalhe: '1º run às 04h', link: null });
    } else {
      const st = cad.status === 'ERROR' || cad.error_kind === 'CREDENTIAL' ? 'vermelho'
        : cad.status === 'SAFEGUARD' || cad.stale ? 'amarelo' : 'verde';
      // ⚠ ZEROS INVENTADOS: no caminho de erro, daily-sync-cadastro chama registrarExecucao SEM
      // stats → a coluna fica NULL. O card fazia `cad.stats || {}` e depois `|| 0`, produzindo
      // "0 novos · 0 mudados · 0 sumidos" — três zeros que NÃO existem no banco. O gestor lia
      // "hoje o cadastro não mudou nada" quando a verdade é "a coleta não chegou a rodar".
      // O branch de cima já sabia distinguir ausência de dado; só faltava aqui.
      const s = cad.stats;
      push({ key: 'cadastro_sync', label: 'Cadastro sync', status: st,
        numeros: s ? `${s.contratos_novos || 0} novos · ${s.atualizados || 0} mudados · ${s.soft_deleted || 0} sumidos`
                   : 'sem dado — a coleta não chegou a rodar',
        detalhe: cad.status === 'OK' ? `ok · ${Math.round((cad.duration_ms || 0) / 1000)}s` : `${cad.status}${cad.error_kind ? ' (' + cad.error_kind + ')' : ''}`, link: null });
    }

    // ---- INGESTÃO / SCRAPE: última falha de login/block (dos syncs de Extranet) ----
    // ⚠ NÃO conta duas vezes o MESMO incidente: esta linha lê o log sem filtro de `kind` (de
    // propósito — falha de QUALQUER sync da Extranet deve aparecer aqui), o que a torna
    // SUPERCONJUNTO do Cadastro sync acima. Quando os dois apontavam para o mesmo run, o card
    // pintava duas linhas e o rótulo dizia "2 precisam de olho" para UMA falha só — o gestor
    // procurava dois problemas e existia um. Exclui o run que a linha de cima já está reportando.
    const cadId = (cad && cad !== FALHOU) ? cad.id : null;
    const scr = await _safe(async () => (await c.query(
      `SELECT error_kind, error, finished_at FROM lead_manager.cadastro_sync_log
        WHERE tenant_id=$1 AND status IN ('ERROR','SAFEGUARD') AND finished_at >= now() - interval '48 hours'
          AND ($2::uuid IS NULL OR id <> $2::uuid)
        ORDER BY created_at DESC LIMIT 1`, [tenantId, cadId])).rows[0] || null, FALHOU);
    // ⚠ SILÊNCIO NÃO É SAÚDE: antes, ausência de falha nas 48h virava 'verde · sem falha'. Um scrape
    // que PAROU de rodar deixa de gerar erro, sai da janela e o semáforo voltava ao verde sozinho.
    // Verde agora exige prova de vida — um run OK recente.
    const ok = await _safe(async () => (await c.query(
      `SELECT finished_at FROM lead_manager.cadastro_sync_log
        WHERE tenant_id=$1 AND status='OK' AND finished_at >= now() - interval '48 hours'
        ORDER BY created_at DESC LIMIT 1`, [tenantId])).rows[0] || null, FALHOU);
    if (scr === FALHOU || ok === FALHOU) push(_indisponivel('scrape', 'Scrape'));
    else if (scr) push({ key: 'scrape', label: 'Scrape', status: scr.error_kind === 'CREDENTIAL' ? 'vermelho' : 'amarelo',
      numeros: `falha ${scr.error_kind || '?'}`, detalhe: String(scr.error || '').slice(0, 60), link: null });
    else if (ok) push({ key: 'scrape', label: 'Scrape', status: 'verde', numeros: 'sem falha (48h)', detalhe: 'último run OK', link: null });
    else push({ key: 'scrape', label: 'Scrape', status: 'cinza', numeros: 'sem coleta (48h)',
      detalhe: 'nenhum run, nem OK nem falha — silêncio não é saúde', link: null });

    // 'cinza' (neutro) NÃO escala o pior — "não rodou" não é alerta.
    const ordem = { cinza: 0, verde: 0, amarelo: 1, vermelho: 2 };
    const pior = systems.reduce((p, s) => ((ordem[s.status] || 0) > ordem[p] ? s.status : p), 'verde');
    return { gerado_em: new Date().toISOString(), pior, systems };
  });
}

module.exports = { resumoPlantao };
