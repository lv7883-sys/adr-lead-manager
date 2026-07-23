'use strict';
// stage-suggestions.itest.js — fatia (b): destravar as sugestões de etapa da IA.
// Cobre: (1) régua canônica sugestaoAtivaSql ≡ isSugestaoAtiva (SQL≡JS) + o count do badge;
// (2) LIMPEZA de órfãs (migração 075) — nula terminal, preserva acionável, snapshot;
// (3) RAIZ — descarte/terminal limpa a sugestão junto (mirror dos handlers); ativa NÃO limpa;
// (4) CONFIRMAR 1-clique + UNDO (snapshot/restore) — restaura estado EXATO + apaga o evento;
// (5) MULTI-TENANT — contagem e limpeza escopadas por tenant.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { sugestaoAtivaSql, isSugestaoAtiva, stageOfLead, KEY_TO_STATUS } = require('../src/stages');

let c;
const T1 = '00000000-0000-0000-0000-0000000000b1';
const T2 = '00000000-0000-0000-0000-0000000000b2';

async function lead(tenant, over = {}) {
  const o = {
    status: 'QUALIFYING', desfecho: null, intent: null, criadoDiasAtras: 0,
    suggested_stage: null, stage_reasoning: null, suggested_stage_dismissed: null, ...over,
  };
  return (await c.query(
    `INSERT INTO leads (tenant_id, status, desfecho, intent, suggested_stage, stage_reasoning, stage_suggested_at, suggested_stage_dismissed, created_at)
     VALUES ($1,$2,$3,$4,$5::text,$6, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, $7, now() - make_interval(days => $8)) RETURNING id`,
    [tenant, o.status, o.desfecho, o.intent, o.suggested_stage, o.stage_reasoning, o.suggested_stage_dismissed, o.criadoDiasAtras])).rows[0].id;
}
const row = async (id) => (await c.query('SELECT * FROM leads WHERE id=$1', [id])).rows[0];
const countAtivas = async (tenant) => (await c.query(
  `SELECT count(*)::int n FROM leads l WHERE l.tenant_id=$1 AND ${sugestaoAtivaSql('l')}`, [tenant])).rows[0].n;
// mirror do count do badge (tenant.js): sugestão ativa AMARRADA à janela default do Kanban (created_at).
const countBadge = async (tenant, days) => (await c.query(
  `SELECT count(*)::int n FROM leads l WHERE l.tenant_id=$1 AND ${sugestaoAtivaSql('l')} AND l.created_at >= now() - make_interval(days => $2)`,
  [tenant, days])).rows[0].n;

// ---- mirrors FIÉIS dos handlers (mesma sequência SQL) ----------------------
async function limparSugestao(id) {   // _limparSugestaoEtapa
  await c.query('UPDATE leads SET suggested_stage=NULL, stage_reasoning=NULL, stage_suggested_at=NULL WHERE id=$1 AND suggested_stage IS NOT NULL', [id]);
}
async function confirmar(tenant, id, autor = 'RECEPCAO') {   // /sugestao-etapa/confirmar
  const l = (await c.query('SELECT status, desfecho, desfecho_em, suggested_stage, stage_reasoning, stage_suggested_at FROM leads WHERE id=$1', [id])).rows[0];
  const destCol = l.suggested_stage;
  const st = KEY_TO_STATUS[destCol];
  // move (só os destinos que a IA sugere: qualificado/experimental/convertido)
  if (destCol === 'convertido') await c.query("UPDATE leads SET status='CONVERTED', desfecho='matriculado', desfecho_em=now() WHERE id=$1", [id]);
  else await c.query('UPDATE leads SET status=$2, desfecho=NULL, desfecho_em=NULL WHERE id=$1', [id, st]);
  const eventoId = (await c.query(
    `INSERT INTO lead_eventos (tenant_id, lead_id, tipo, autor, conteudo, etapa_key)
     VALUES ($1,$2,'mudanca_etapa',$3,$4,$5) RETURNING id`,
    [tenant, id, autor, `movido para ${destCol} — sugestão da IA confirmada`, destCol])).rows[0].id;
  await limparSugestao(id);
  return {
    lead_id: id, kind: 'stage', restore_path: 'sugestao-etapa/restaurar',
    prior: { status: l.status, desfecho: l.desfecho, desfecho_em: l.desfecho_em },
    suggested_stage: l.suggested_stage, stage_reasoning: l.stage_reasoning, stage_suggested_at: l.stage_suggested_at,
    evento_id: eventoId,
  };
}
async function restaurar(id, snap) {   // /sugestao-etapa/restaurar
  const p = snap.prior;
  await c.query(
    `UPDATE leads SET status=$2, desfecho=$3, desfecho_em=$4, suggested_stage=$5, stage_reasoning=$6, stage_suggested_at=$7 WHERE id=$1`,
    [id, p.status, p.desfecho, p.desfecho_em, snap.suggested_stage, snap.stage_reasoning, snap.stage_suggested_at]);
  if (snap.evento_id) await c.query("DELETE FROM lead_eventos WHERE id=$1 AND lead_id=$2 AND tipo='mudanca_etapa'", [snap.evento_id, id]);
}
const nEventos = async (id) => (await c.query("SELECT count(*)::int n FROM lead_eventos WHERE lead_id=$1 AND tipo='mudanca_etapa'", [id])).rows[0].n;

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query(`
    CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, status text, desfecho text,
      desfecho_em timestamptz, intent text, suggested_stage text, stage_reasoning text, stage_suggested_at timestamptz,
      suggested_stage_dismissed text, created_at timestamptz DEFAULT now());
    CREATE TABLE lead_eventos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, tipo text,
      autor text, conteudo text, etapa_key text, criado_em timestamptz DEFAULT now());`);
});
after(async () => { await c.end(); });

test('(1) sugestaoAtivaSql ≡ isSugestaoAtiva (SQL==JS) e o count = acionáveis', async () => {
  // acionáveis (3): experimental/qualificado/convertido em lead vivo
  const a1 = await lead(T1, { status: 'QUALIFYING', suggested_stage: 'experimental' });
  await lead(T1, { status: 'QUALIFYING', suggested_stage: 'convertido' });
  await lead(T1, { status: 'QUALIFIED', suggested_stage: 'convertido' });
  // NÃO acionáveis: terminal (NOT_LEAD, desfecho), sugestão==etapa atual, sugestão dispensada
  await lead(T1, { status: 'NOT_LEAD', suggested_stage: 'experimental' });
  await lead(T1, { status: 'QUALIFYING', desfecho: 'matriculado', suggested_stage: 'experimental' });
  await lead(T1, { status: 'QUALIFYING', suggested_stage: 'qualificando' });          // == etapa atual
  await lead(T1, { status: 'QUALIFYING', suggested_stage: 'experimental', suggested_stage_dismissed: 'experimental' });
  // SQL≡JS linha a linha
  const rows = (await c.query(`SELECT *, (${sugestaoAtivaSql('l')}) AS sql_ativa FROM leads l WHERE l.tenant_id=$1`, [T1])).rows;
  for (const r of rows) assert.equal(r.sql_ativa, isSugestaoAtiva(r), `SQL≡JS p/ ${r.status}/${r.suggested_stage}`);
  assert.equal(await countAtivas(T1), 3, 'count do badge = 3 acionáveis');
  assert.equal(stageOfLead({ status: 'QUALIFYING' }), 'qualificando');   // sanidade da etapa atual
});

test('(2) LIMPEZA de órfãs (migração 075): nula terminal, preserva acionável, snapshot', async () => {
  const ativo = await lead(T2, { status: 'QUALIFYING', suggested_stage: 'experimental' });
  const orfaNL = await lead(T2, { status: 'NOT_LEAD', suggested_stage: 'experimental' });
  const orfaDf = await lead(T2, { status: 'QUALIFIED', desfecho: 'nao_matriculado_preco', suggested_stage: 'convertido' });
  // mirror da migração: snapshot + UPDATE
  await c.query(`CREATE TABLE bkp_orphans (id uuid, suggested_stage text)`);
  await c.query(`INSERT INTO bkp_orphans SELECT id, suggested_stage FROM leads
                 WHERE suggested_stage IS NOT NULL AND (status IN ('NOT_LEAD','REVIEW_QUEUE') OR desfecho IS NOT NULL) AND tenant_id=$1`, [T2]);
  await c.query(`UPDATE leads SET suggested_stage=NULL, stage_reasoning=NULL, stage_suggested_at=NULL
                 WHERE suggested_stage IS NOT NULL AND (status IN ('NOT_LEAD','REVIEW_QUEUE') OR desfecho IS NOT NULL) AND tenant_id=$1`, [T2]);
  assert.equal((await row(orfaNL)).suggested_stage, null, 'órfã NOT_LEAD anulada');
  assert.equal((await row(orfaDf)).suggested_stage, null, 'órfã com desfecho anulada');
  assert.equal((await row(ativo)).suggested_stage, 'experimental', 'acionável preservada');
  assert.equal((await c.query('SELECT count(*)::int n FROM bkp_orphans')).rows[0].n, 2, 'snapshot guardou as 2 órfãs (não deleta cego)');
});

test('(3) RAIZ: descarte/terminal limpa a sugestão; lead vivo NÃO limpa', async () => {
  const descartado = await lead(T1, { status: 'QUALIFYING', suggested_stage: 'experimental' });
  // mirror do handler de descarte: seta NOT_LEAD e chama _limparSugestaoEtapa
  await c.query("UPDATE leads SET status='NOT_LEAD' WHERE id=$1", [descartado]);
  await limparSugestao(descartado);
  assert.equal((await row(descartado)).suggested_stage, null, 'descarte limpou a sugestão (raiz)');
  // lead que segue vivo: NÃO limpa (só terminal chama o helper)
  const vivo = await lead(T1, { status: 'QUALIFYING', suggested_stage: 'experimental' });
  assert.equal((await row(vivo)).suggested_stage, 'experimental', 'lead vivo mantém a sugestão');
});

test('(4) CONFIRMAR 1-clique + UNDO restaura EXATO + apaga o evento', async () => {
  const id = await lead(T1, { status: 'QUALIFYING', suggested_stage: 'experimental', stage_reasoning: 'marcou aula' });
  const snap = await confirmar(T1, id);
  let r = await row(id);
  assert.equal(r.status, 'EXPERIMENTAL_AGENDADA', 'confirmar moveu p/ a etapa sugerida');
  assert.equal(r.suggested_stage, null, 'confirmar limpou a sugestão');
  assert.equal(await nEventos(id), 1, 'confirmar logou 1 evento de mudança');
  assert.equal(snap.restore_path, 'sugestao-etapa/restaurar', 'snapshot carrega o restore_path próprio');
  // UNDO
  await restaurar(id, snap);
  r = await row(id);
  assert.equal(r.status, 'QUALIFYING', 'undo restaurou o status anterior');
  assert.equal(r.desfecho, null, 'undo restaurou o desfecho anterior');
  assert.equal(r.suggested_stage, 'experimental', 'undo restaurou a própria sugestão');
  assert.equal(r.stage_reasoning, 'marcou aula', 'undo restaurou o reasoning');
  assert.equal(await nEventos(id), 0, 'undo apagou o evento que a confirmação criou');
  assert.equal(isSugestaoAtiva(r), true, 'volta a ser sugestão acionável (aparece no badge de novo)');
});

test('(4b) CONFIRMAR→convertido + UNDO restaura desfecho', async () => {
  const id = await lead(T1, { status: 'QUALIFYING', suggested_stage: 'convertido' });
  const snap = await confirmar(T1, id);
  let r = await row(id);
  assert.equal(r.status, 'CONVERTED'); assert.equal(r.desfecho, 'matriculado');
  await restaurar(id, snap);
  r = await row(id);
  assert.equal(r.status, 'QUALIFYING'); assert.equal(r.desfecho, null, 'undo tirou o matriculado');
  assert.equal(r.suggested_stage, 'convertido');
});

test('(4c) BADGE amarrado à janela do Kanban: acionável fora do período não conta', async () => {
  await c.query('DELETE FROM leads');
  await lead(T1, { status: 'QUALIFYING', suggested_stage: 'experimental', criadoDiasAtras: 5 });   // dentro de 30d
  await lead(T1, { status: 'QUALIFIED', suggested_stage: 'convertido', criadoDiasAtras: 40 });      // fora de 30d, dentro de 90d
  assert.equal(await countAtivas(T1), 2, 'sem filtro de período: 2 acionáveis (o número "todos")');
  assert.equal(await countBadge(T1, 30), 1, 'badge (30d) = 1: só o card à vista no default');
  assert.equal(await countBadge(T1, 90), 2, 'em 90d os 2 aparecem (invariante badge==cards vale por período)');
});

test('(5) MULTI-TENANT: count e limpeza escopados por tenant', async () => {
  // limpa o estado e semeia 2 acionáveis no T1, 1 no T2
  await c.query('DELETE FROM leads');
  await lead(T1, { status: 'QUALIFYING', suggested_stage: 'experimental' });
  await lead(T1, { status: 'QUALIFIED', suggested_stage: 'convertido' });
  const t2id = await lead(T2, { status: 'QUALIFYING', suggested_stage: 'experimental' });
  assert.equal(await countAtivas(T1), 2, 'T1 conta só as suas');
  assert.equal(await countAtivas(T2), 1, 'T2 conta só as suas');
  // descartar no T2 não mexe no count do T1
  await c.query("UPDATE leads SET status='NOT_LEAD' WHERE id=$1", [t2id]); await limparSugestao(t2id);
  assert.equal(await countAtivas(T2), 0);
  assert.equal(await countAtivas(T1), 2, 'T1 intacto');
});
