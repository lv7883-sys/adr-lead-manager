'use strict';
/*
 * deploy/backfill-stage-autoapply.js — aplica as sugestões de etapa PENDENTES existentes (migration 078),
 * respeitando o corte por risco do Leo: só as etapas da lista elegível do tenant (stage_autoapply_stages,
 * default {experimental,qualificado}). 'convertido' fica SEGURADO (suggestion-only, julgamento manual).
 *
 * DEFAULT = DRY-RUN (read-only): lista o que SERIA aplicado vs segurado, sem mover nada.
 *   node deploy/backfill-stage-autoapply.js
 * APLICAR de verdade (move + audita em stage_autoapply_log; revertível 1-a-1 no Monitor):
 *   node deploy/backfill-stage-autoapply.js --apply
 *
 * Universo = MESMO predicado do badge (stages.sugestaoAtivaSql). Cada movimento vira uma linha em
 * stage_autoapply_log (source='backfill') com snapshot → o REVERTER do Monitor desfaz individualmente.
 * Reverter em lote:  UPDATE ... ver instruções impressas no fim do --apply.
 */
const engine = require('../src/engine');
const stages = require('../src/stages');
const { pool, withTenant } = require('../src/db');
const TENANT_ID = process.env.TENANT_ID || 'ed731a58-62e5-45ad-acba-a5502ff39e92';
const APPLY = process.argv.includes('--apply');

async function config(c) {
  try {
    const r = (await c.query(
      'SELECT stage_autoapply_mode, stage_autoapply_stages FROM tenant_lead_config WHERE tenant_id = $1', [TENANT_ID])).rows[0];
    return { mode: r?.stage_autoapply_mode || 'off', allowed: Array.isArray(r?.stage_autoapply_stages) ? r.stage_autoapply_stages : [] };
  } catch (e) {
    // colunas da 078 ainda não existem (preview PRÉ-migração): usa o default da decisão. NÃO habilita --apply.
    if (/column .* does not exist/i.test(e.message)) return { mode: 'off(pré-078)', allowed: ['experimental', 'qualificado'], preMigration: true };
    throw e;
  }
}
async function pendentes(c) {
  return (await c.query(
    `SELECT l.id::text, l.name, l.suggested_stage, l.stage_reasoning,
            (${stages.stageSql('l')}) AS etapa_atual
       FROM lead_manager.leads l
      WHERE l.tenant_id = $1 AND ${stages.sugestaoAtivaSql('l')}
      ORDER BY l.stage_suggested_at DESC NULLS LAST`, [TENANT_ID])).rows;
}
const one = (t) => (t || '').replace(/\s+/g, ' ').trim().slice(0, 110);

(async () => {
  try {
    // Transações SEPARADAS: se a config falhar (colunas 078 ausentes no preview), não envenena o SELECT
    // de pendentes (uma query com erro aborta a transação inteira no Postgres).
    const cfg = await withTenant(TENANT_ID, (c) => config(c));
    const rows = await withTenant(TENANT_ID, (c) => pendentes(c));
    const allowed = new Set(cfg.allowed);
    const aplicaveis = rows.filter((r) => allowed.has(r.suggested_stage));
    const segurados = rows.filter((r) => !allowed.has(r.suggested_stage));
    const grp = (arr) => arr.reduce((a, r) => (a[r.suggested_stage] = (a[r.suggested_stage] || 0) + 1, a), {});

    console.log(`tenant=${TENANT_ID}  mode=${cfg.mode}  lista_elegivel=${JSON.stringify([...allowed])}`);
    console.log(`pendentes(total)=${rows.length}  →  APLICÁVEIS=${aplicaveis.length} ${JSON.stringify(grp(aplicaveis))}  |  SEGURADOS=${segurados.length} ${JSON.stringify(grp(segurados))}`);
    console.log(APPLY ? '\n=== MODO --apply: MOVENDO ===\n' : '\n=== DRY-RUN (nada move) — SERIAM aplicados: ===\n');

    if (cfg.mode !== 'on' && APPLY) {
      console.log('ABORTADO: stage_autoapply_mode != on (rode a migration 078 antes de --apply).');
      return;
    }

    let moved = 0, skipped = 0;
    for (const r of aplicaveis) {
      if (!APPLY) {
        console.log(`[SERIA] ${r.name || '(sem nome)'}  ${r.etapa_atual} → ${r.suggested_stage}   « ${one(r.stage_reasoning)} »`);
        continue;
      }
      const out = await withTenant(TENANT_ID, (c) => engine._autoAplicarEtapa(c, {
        tenantId: TENANT_ID, leadId: r.id, destCol: r.suggested_stage, reasoning: r.stage_reasoning, source: 'backfill',
      }));
      if (out.applied) { moved++; console.log(`[OK] ${r.name}  ${out.from} → ${r.suggested_stage}`); }
      else { skipped++; console.log(`[PULOU:${Object.keys(out)[0]}] ${r.name}  → ${r.suggested_stage}`); }
    }
    console.log('\n--- SEGURADOS (suggestion-only, julgamento manual do Leo) ---');
    for (const r of segurados) console.log(`[SEGURADO] ${r.name || '(sem nome)'}  ${r.etapa_atual} → ${r.suggested_stage}   « ${one(r.stage_reasoning)} »`);

    if (APPLY) {
      console.log(`\nRESUMO: movidos=${moved}  pulados=${skipped}  segurados=${segurados.length}`);
      console.log('REVERTER EM LOTE (desfaz este backfill; o Monitor também reverte 1-a-1):');
      console.log(`  -- restaura estado anterior de cada linha e apaga o evento; rode como postgres:
  UPDATE lead_manager.leads l SET status=s.prior_status, desfecho=s.prior_desfecho,
         desfecho_em=s.prior_desfecho_em, suggested_stage=s.to_stage, updated_at=now()
    FROM lead_manager.stage_autoapply_log s
   WHERE s.lead_id=l.id AND s.source='backfill' AND s.reverted=false AND s.tenant_id='${TENANT_ID}';
  DELETE FROM lead_manager.lead_eventos e USING lead_manager.stage_autoapply_log s
   WHERE e.id=s.evento_id AND s.source='backfill' AND s.reverted=false AND s.tenant_id='${TENANT_ID}';
  UPDATE lead_manager.stage_autoapply_log SET reverted=true, reverted_at=now(), reverted_by='backfill_revert'
   WHERE source='backfill' AND reverted=false AND tenant_id='${TENANT_ID}';`);
    } else {
      console.log(`\n(dry-run) Para aplicar os ${aplicaveis.length}: node deploy/backfill-stage-autoapply.js --apply`);
    }
  } finally {
    try { await pool.end(); } catch {}
    try { require('../src/redisClient').redis.disconnect(); } catch {}
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
