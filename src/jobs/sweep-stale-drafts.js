'use strict';

// ============================================================================
// SWEEP — arquiva RASCUNHOS (pending_approvals) STALE, reconciliando o "X aguardando
// aprovação" com a fila de ação. Reversível, NÃO deleta histórico.
//
// Um rascunho é uma RESPOSTA PRONTA para um lead que precisa de resposta → subconjunto da
// fila. Rascunho pendente de lead que NÃO está AGUARDANDO_RECEPCAO é stale:
//   (a) conversation_state RESOLVIDO ou AGUARDANDO_CLIENTE (com estado FRESCO — computado
//       após o último inbound; se o cliente re-engajou depois, NÃO arquiva), OU
//   (b) lead já terminal/fora da fila (CONVERTED / NOT_LEAD / EXPERIMENTAL_AGENDADA, ou com
//       desfecho) — resposta "aguardando aprovação" não faz sentido.
// PRESERVA (não arquiva): AGUARDANDO_RECEPCAO, INDEFINIDO/sem-estado em lead ativo (na
// dúvida NUNCA esconde quem pode estar esperando).
//
//   APPLY=0 -> dry-run (só conta/relatório)         APPLY=1 -> snapshot + arquiva
//   docker exec -e APPLY=0 -i adr-lead-manager node src/jobs/sweep-stale-drafts.js
//
// Arquivar = status 'PENDING' -> 'ARCHIVED' (migration 040). Sai de TODOS os contadores
// (filtram status='PENDING'); a linha + suggested_response ficam. Snapshot + REVERT abaixo.
// ============================================================================

const { withTenant } = require('../db');

const TENANT = process.env.VALIDA_TENANT || 'ed731a58-62e5-45ad-acba-a5502ff39e92';
const APPLY = process.env.APPLY === '1';
const SNAP = `bkp_stale_drafts_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

// Predicado do que é STALE (a ∪ b). Compartilhado entre dry-run e apply.
const STALE_CTE = `
  WITH last_in AS (
    SELECT regexp_replace(cv.external_id,'[^0-9]','','g') AS ident, max(m.received_at) AS last_in
      FROM lead_manager.messages m JOIN lead_manager.conversations cv ON cv.id=m.conversation_id
     WHERE cv.tenant_id=$1 AND m.role='USER' GROUP BY 1),
  stale AS (
    SELECT pa.id AS approval_id, l.id AS lead_id, l.name, l.status, l.desfecho,
           l.conversation_state AS st,
           (l.status IN ('CONVERTED','NOT_LEAD','EXPERIMENTAL_AGENDADA') OR l.desfecho IS NOT NULL) AS inativo,
           (l.conversation_state IN ('RESOLVIDO','AGUARDANDO_CLIENTE')
              AND (li.last_in IS NULL OR (l.state_computed_at IS NOT NULL AND l.state_computed_at >= li.last_in))) AS estado_stale
      FROM lead_manager.pending_approvals pa
      JOIN lead_manager.leads l ON l.id=pa.lead_id
      LEFT JOIN last_in li ON li.ident=regexp_replace(coalesce(l.phone,l.meta_psid,''),'[^0-9]','','g')
     WHERE pa.tenant_id=$1 AND pa.status='PENDING')`;

(async () => {
  console.log(`MODO: ${APPLY ? 'APPLY (arquiva)' : 'DRY-RUN'} | snapshot=${SNAP} | tenant=${TENANT}`);
  await withTenant(TENANT, async (c) => {
    const rel = (await c.query(`${STALE_CTE}
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE inativo OR estado_stale) AS arquivar,
        count(*) FILTER (WHERE estado_stale AND NOT inativo AND st='RESOLVIDO') AS por_resolvido,
        count(*) FILTER (WHERE estado_stale AND NOT inativo AND st='AGUARDANDO_CLIENTE') AS por_aguardando_cliente,
        count(*) FILTER (WHERE inativo) AS por_lead_inativo,
        count(*) FILTER (WHERE NOT (inativo OR estado_stale)) AS mantem,
        count(DISTINCT lead_id) FILTER (WHERE NOT (inativo OR estado_stale)) AS leads_mantidos
      FROM stale`, [TENANT])).rows[0];

    console.log('\n=== PLANO ===');
    console.log(`total PENDING:            ${rel.total}`);
    console.log(`  arquivar (stale):       ${rel.arquivar}`);
    console.log(`    · RESOLVIDO:          ${rel.por_resolvido}`);
    console.log(`    · AGUARDANDO_CLIENTE: ${rel.por_aguardando_cliente}`);
    console.log(`    · lead inativo/term.: ${rel.por_lead_inativo}`);
    console.log(`  manter (resposta real): ${rel.mantem}  (${rel.leads_mantidos} leads AGUARDANDO_RECEPCAO/indefinido)`);

    if (!APPLY) { console.log('\nDRY-RUN — nada escrito. Rode com APPLY=1 para arquivar.'); return; }
    if (Number(rel.arquivar) === 0) { console.log('\nNada stale — nenhuma escrita.'); return; }

    // SNAPSHOT (reversível) + ARQUIVA, numa transação. Guarda só os ids que mudaram.
    await c.query(`CREATE TABLE IF NOT EXISTS lead_manager.${SNAP}
                     (approval_id uuid PRIMARY KEY, prev_status text, snap_at timestamptz DEFAULT now())`);
    await c.query(`${STALE_CTE}
      INSERT INTO lead_manager.${SNAP} (approval_id, prev_status)
      SELECT approval_id, 'PENDING' FROM stale WHERE (inativo OR estado_stale)
      ON CONFLICT (approval_id) DO NOTHING`, [TENANT]);
    const upd = await c.query(`${STALE_CTE}
      UPDATE lead_manager.pending_approvals pa SET status='ARCHIVED'
        FROM stale WHERE pa.id = stale.approval_id AND (stale.inativo OR stale.estado_stale)
          AND pa.status='PENDING'`, [TENANT]);
    console.log(`\nArquivados: ${upd.rowCount} | snapshot=lead_manager.${SNAP}`);
    console.log(`REVERT:\n  UPDATE lead_manager.pending_approvals pa SET status=b.prev_status\n    FROM lead_manager.${SNAP} b WHERE b.approval_id=pa.id AND pa.status='ARCHIVED';\n  DROP TABLE lead_manager.${SNAP};`);
  });
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
