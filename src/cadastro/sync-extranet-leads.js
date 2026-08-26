'use strict';
//
// sync-extranet-leads.js — SYNC CORE dos leads da Extranet (migr 102). Agnóstico de fonte: recebe
// o snapshot do adapter (valinhos-leads) e roda DENTRO de withTenant (RLS). Três passos:
//   1) ESPELHO  — upsert por (tenant_id, extranet_id); ausente do snapshot → soft-delete
//                 (fonte_ausente_em), nunca apaga; reaparecer limpa.
//   2) MATCHING — linha com telefone e sem lead_id: casa lead existente por br_phone_key (dedup
//                 com/sem 55, com/sem 9º dígito — a MESMA chave da fusão de conversas/094);
//                 não achou → CRIA lead (origem='extranet', first-touch imutável/043, sem conversa
//                 — precedente Meta leadgen). Sem telefone → mirror-only.
//   3) RÉGUA    — Situação → etapa, FORWARD-ONLY (nunca rebaixa; ordinal cresce), com as guardas
//                 do molde contractConvert: latch humano, desfecho existente e status fora do
//                 funil são intocáveis. 'convertido' (matrícula) grava desfecho='matriculado' +
//                 desfecho_source='extranet' (042) — vira terminal e a IA para de tocar.
//                 mode 'auto' move com lead_eventos (autor 'extranet_auto') + stage_autoapply_log
//                 (source 'extranet_lead') → reversível card a card no Monitor da 078.
//                 mode 'suggestion' só grava suggested_stage (respeita dismissed, molde
//                 persistStageSuggestion). Situação desconhecida → não move, conta no stats.
//
// HIERARQUIA: HUMANO > EXTRANET > IA (o gêmeo anti-rebaixamento da IA vive no engine, que consulta
// extranetLeadStage.sustainedStageKey). Idempotente: re-run do mesmo snapshot = 0 movimentos.
//
const telBR = require('../telefoneBR');
const stages = require('../stages');
const { mapSituacao, ORDINAL, carimbosExperimental } = require('./extranetLeadStage');

// Alvos que o modo AUTO pode aplicar como MOVE de status (sem desfecho). 'convertido' tem caminho
// próprio (matrícula). NUNCA derivar do ordinal cru: 'perdido' (6) e 'cliente' (7) são "maiores"
// que experimental e jamais são destino da máquina.
const AUTO_MOVE_TARGETS = new Set(['qualificando', 'qualificado', 'experimental']);

const _digits = (s) => String(s || '').replace(/\D/g, '');

// ---- passo 1: espelho -------------------------------------------------------------------------
// windowStart (janela deslizante do adapter): o snapshot só cobre leads recentes. Soft-delete
// então é ESCOPADO à janela — linha ausente do snapshot que apenas ENVELHECEU para fora da
// janela NÃO é "sumiu da fonte" (fica intocada, presente). Sem windowStart → snapshot completo,
// soft-delete global (comportamento dos itests sintéticos).
async function upsertEspelho(c, tenantId, rows, stats, windowStart) {
  const ids = [];
  for (const r of rows) {
    ids.push(r.extranetId);
    // CARIMBOS (migr 106): `situacao` é estado atual e é SOBRESCRITA abaixo — quando a Extranet
    // passa o lead para 'Ganhou', 'Exp. Realizada' some e o funil perde a prova de que a aula
    // aconteceu. Este upsert é o único ponto que vê o badge antes disso, então grava o fato uma
    // vez (COALESCE) e nunca o limpa. Situação que não é experimental passa `false` → não apaga
    // carimbo anterior (o lead avança de Exp. Realizada para Ganhou sem perder a história).
    const carimbo = carimbosExperimental(r.situacao);
    if (carimbo.agendada) stats.exp_agendada_vista++;
    if (carimbo.realizada) stats.exp_realizada_vista++;
    const up = await c.query(
      `INSERT INTO lead_manager.extranet_lead
         (tenant_id, extranet_id, nome, fone_raw, curso, professor, situacao,
          data_cadastro, ult_contato, prox_contato, exp_agendada_em, exp_realizada_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               CASE WHEN $11::boolean THEN now() END, CASE WHEN $12::boolean THEN now() END)
       ON CONFLICT (tenant_id, extranet_id) DO UPDATE SET
         nome=EXCLUDED.nome, fone_raw=EXCLUDED.fone_raw, curso=EXCLUDED.curso,
         professor=EXCLUDED.professor, situacao=EXCLUDED.situacao,
         data_cadastro=EXCLUDED.data_cadastro, ult_contato=EXCLUDED.ult_contato,
         prox_contato=EXCLUDED.prox_contato,
         exp_agendada_em=COALESCE(extranet_lead.exp_agendada_em,
                                  CASE WHEN $11::boolean THEN now() END),
         exp_realizada_em=COALESCE(extranet_lead.exp_realizada_em,
                                   CASE WHEN $12::boolean THEN now() END),
         last_seen_at=now(), fonte_ausente_em=NULL, updated_at=now()
       RETURNING id, lead_id, phone_key, situacao, (xmax = 0) AS inserted`,
      [tenantId, r.extranetId, r.nome || null, r.foneRaw || null, r.curso || null,
       r.professor || null, r.situacao || null, r.dataCadastro || null,
       r.ultContato || null, r.proxContato || null, carimbo.agendada, carimbo.realizada]);
    const row = up.rows[0];
    stats[row.inserted ? 'espelho_novos' : 'espelho_atualizados']++;
    r._mirrorId = row.id; r._leadId = row.lead_id; r._phoneKey = row.phone_key;
  }
  // soft-delete do que sumiu da fonte, DENTRO da janela do snapshot
  const del = await c.query(
    `UPDATE lead_manager.extranet_lead SET fonte_ausente_em=now(), updated_at=now()
      WHERE tenant_id=$1 AND fonte_ausente_em IS NULL AND NOT (extranet_id = ANY($2::text[]))
        AND ($3::date IS NULL OR data_cadastro IS NULL OR data_cadastro >= $3::date)`,
    [tenantId, ids, windowStart || null]);
  stats.soft_deleted = del.rowCount;
}

// ---- passo 2: matching / criação --------------------------------------------------------------
async function matchOuCria(c, tenantId, r, stats) {
  if (r._leadId) return r._leadId;                       // já linkado em run anterior
  if (!r._phoneKey) { stats.sem_telefone++; return null; }
  const cand = (await c.query(
    `SELECT id, phone, updated_at FROM lead_manager.leads
      WHERE tenant_id=$1 AND phone IS NOT NULL AND lead_manager.br_phone_key(phone) = $2
      ORDER BY updated_at DESC`,
    [tenantId, r._phoneKey])).rows;
  let leadId = null;
  if (cand.length) {
    if (cand.length > 1) stats.ambiguos++;
    // preferência: match EXATO de dígitos; senão o tocado mais recentemente
    const exato = cand.find((l) => _digits(l.phone) === _digits(r.foneRaw));
    leadId = (exato || cand[0]).id;
    stats.linkados++;
  } else {
    const phone = telBR.toE164BR(r.foneRaw);
    if (!phone) { stats.sem_telefone++; return null; }
    // blindagem de corrida com o webhook (molde engine.js:1576) — conflito exato de phone
    const ins = await c.query(
      `INSERT INTO lead_manager.leads (tenant_id, name, phone, status, origem)
       VALUES ($1,$2,$3,'NEW','extranet')
       ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL
       DO UPDATE SET updated_at=now()
       RETURNING id, (xmax = 0) AS inserted`,
      [tenantId, r.nome || phone, phone]);
    leadId = ins.rows[0].id;
    if (ins.rows[0].inserted) stats.leads_criados++; else stats.linkados++;
  }
  await c.query('UPDATE lead_manager.extranet_lead SET lead_id=$2, updated_at=now() WHERE id=$1',
    [r._mirrorId, leadId]);
  r._leadId = leadId;
  return leadId;
}

// ---- passo 3: régua forward-only --------------------------------------------------------------
// Guardas na ordem do molde contractConvert._aplicar. Devolve o que fez (p/ stats).
async function aplicarRegua(c, tenantId, r, mode, stats) {
  const { key: alvo, known } = mapSituacao(r.situacao);
  if (!known) { if (String(r.situacao || '').trim()) stats._desconhecidas.add(r.situacao.trim()); return; }
  if (!alvo) return;                                     // mapeada para mirror-only (perda etc.)

  const l = (await c.query(
    `SELECT status, desfecho, desfecho_em, review_result, review_by,
            suggested_stage, suggested_stage_dismissed
       FROM lead_manager.leads WHERE id=$1`, [r._leadId])).rows[0];
  if (!l) return;
  // 1) latch humano — decisão de gente é terminal
  if (l.review_result === 'confirmed_not_lead' && l.review_by && l.review_by !== 'SERVICE') return;
  // 2) desfecho existente (matriculado/perda/cliente) e status fora do funil: intocáveis
  if (l.desfecho != null) return;
  const st = String(l.status || '').toUpperCase();
  if (['NOT_LEAD', 'REVIEW_QUEUE', 'PENDING_CLASSIFICATION', 'OPTED_OUT'].includes(st)) return;
  // 3) forward-only por ordinal
  const atual = stages.stageKey(l.status, l.desfecho);
  if (ORDINAL[alvo] <= ORDINAL[atual]) return;           // já está lá ou à frente → no-op
  // 4) DISPENSA HUMANA: reverter no Monitor (078) grava suggested_stage_dismissed=etapa — a
  //    recepção disse "essa etapa NÃO". Vale para o AUTO também (Humano > Extranet); sem isso o
  //    run de 3h re-aplicaria o move revertido em loop. Situação NOVA (outra etapa) volta a valer.
  if (alvo === l.suggested_stage_dismissed) return;

  if (mode !== 'auto') {                                  // suggestion (molde persistStageSuggestion)
    if (alvo === l.suggested_stage) return;
    await c.query(
      `UPDATE lead_manager.leads SET suggested_stage=$2, stage_reasoning=$3, stage_suggested_at=now()
        WHERE id=$1`,
      [r._leadId, alvo, `Extranet: situação "${r.situacao}"`]);
    stats.sugeridos++;
    return;
  }

  // AUTO — move com evento + log reversível (molde _autoAplicarEtapa/_aplicar)
  if (alvo === 'convertido') {
    // MATRÍCULA: fato da Extranet → terminal. desfecho_em = cadastro na Extranet não é a data da
    // matrícula; sem data melhor na lista, now() (o contractConvert NÃO sobrescreve depois: skip
    // 'already'; a data fina continua vindo do fluxo de contratos quando ele agir primeiro).
    await c.query(
      `UPDATE lead_manager.leads SET status='CONVERTED', desfecho='matriculado',
              desfecho_source='extranet', desfecho_em=COALESCE(desfecho_em, now()), updated_at=now()
        WHERE id=$1`, [r._leadId]);
  } else if (AUTO_MOVE_TARGETS.has(alvo)) {
    await c.query(
      `UPDATE lead_manager.leads SET status=$2, updated_at=now() WHERE id=$1`,
      [r._leadId, stages.KEY_TO_STATUS[alvo]]);
  } else return;                                          // nunca: perdido/cliente não são destino

  const conteudo = `movido para ${alvo} — situação "${String(r.situacao).trim()}" na Extranet`;
  const evento = (await c.query(
    `INSERT INTO lead_manager.lead_eventos (tenant_id, lead_id, tipo, autor, conteudo, etapa_key)
     VALUES ($1,$2,'mudanca_etapa','extranet_auto',$3,$4) RETURNING id`,
    [tenantId, r._leadId, conteudo, alvo])).rows[0];
  await c.query(
    'UPDATE lead_manager.leads SET suggested_stage=NULL, stage_reasoning=NULL, stage_suggested_at=NULL WHERE id=$1',
    [r._leadId]);
  await c.query(
    `INSERT INTO lead_manager.stage_autoapply_log
       (tenant_id, lead_id, from_stage, to_stage, reasoning, source,
        prior_status, prior_desfecho, prior_desfecho_em, evento_id)
     VALUES ($1,$2,$3,$4,$5,'extranet_lead',$6,$7,$8,$9)`,
    [tenantId, r._leadId, atual, alvo, conteudo, l.status, l.desfecho, l.desfecho_em, evento.id]);
  stats.movidos++;
}

// ---- entrada ----------------------------------------------------------------------------------
// mode: 'suggestion' | 'auto' (o runner pula 'off' antes de chegar aqui).
async function syncExtranetLeads(c, { tenantId, snapshot, mode }) {
  const stats = {
    espelho_novos: 0, espelho_atualizados: 0, soft_deleted: 0,
    linkados: 0, leads_criados: 0, sem_telefone: 0, ambiguos: 0,
    movidos: 0, sugeridos: 0, _desconhecidas: new Set(),
    // migr 106 — quantos leads DESTE snapshot estavam em situação que prova aula experimental.
    // Sem isso não dá pra verificar o carimbo depois do deploy sem abrir o banco. Não é "quantos
    // foram carimbados agora" (o COALESCE não recarimba): é o volume observado no run.
    exp_agendada_vista: 0, exp_realizada_vista: 0,
  };
  const rows = snapshot.leads || [];
  await upsertEspelho(c, tenantId, rows, stats, snapshot.windowStart);
  for (const r of rows) {
    const leadId = await matchOuCria(c, tenantId, r, stats);
    if (leadId) await aplicarRegua(c, tenantId, r, mode, stats);
  }
  stats.situacao_desconhecida = [...stats._desconhecidas];
  delete stats._desconhecidas;
  return stats;
}

module.exports = { syncExtranetLeads };
