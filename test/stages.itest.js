'use strict';
// stages.itest.js — Passo 1: régua canônica de estágios (src/stages.js). É REFACTOR: prova que a
// nova fonte única reproduz EXATAMENTE o comportamento antigo (kanbanColuna + OR-proxy do funil),
// que SQL ≡ JS (sem cópia divergente) e que loadStages cai no default sem config (multi-tenant).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const {
  stageKey, stageOfLead, isStage, stageSql, funilBucketSql, temFatoExtranetSql, loadStages,
  KANBAN_TRANSICOES, STATUS_TO_KEY, KEY_TO_STATUS, PERDIDO_DESFECHOS,
} = require('../src/stages');

// ---- referência ANTIGA (copiada dos originais, ANTES do refactor) — o alvo a igualar -----------
function kanbanColunaOLD(status, desfecho) {
  const P = ['nao_matriculado_preco', 'nao_matriculado_horario', 'nao_matriculado_concorrente',
    'nao_matriculado_desistiu', 'nao_compareceu_aula', 'outro'];
  if (P.includes(desfecho)) return 'perdido';
  if (desfecho === 'matriculado' || status === 'CONVERTED') return 'convertido';
  if (status === 'NEW') return 'novo';
  if (status === 'EXPERIMENTAL_AGENDADA') return 'experimental';
  if (status === 'QUALIFIED') return 'qualificado';
  return 'qualificando';
}
// funil OR-proxy ANTIGO (metrics.js, inline) — as três FILTER expressions, byte-a-byte.
const OLD_AGENDADA = "intent = 'SCHEDULE_INTEREST' OR status = 'EXPERIMENTAL_AGENDADA' OR desfecho = 'nao_compareceu_aula'";
const OLD_REALIZADA = `(${OLD_AGENDADA}) AND desfecho IS NOT NULL AND desfecho <> 'nao_compareceu_aula'`;
const OLD_MATRICULA = "desfecho = 'matriculado'";

const STATUSES = ['NEW', 'QUALIFYING', 'QUALIFIED', 'EXPERIMENTAL_AGENDADA', 'CONVERTED', 'PERDIDO', 'NOT_LEAD', 'REVIEW_QUEUE', null];
const DESFECHOS = [null, 'matriculado', 'nao_compareceu_aula', 'nao_matriculado_preco', 'nao_matriculado_horario',
  'nao_matriculado_concorrente', 'nao_matriculado_desistiu', 'outro', 'nao_e_lead', 'xpto'];
const INTENTS = [null, 'SCHEDULE_INTEREST', 'GENERAL_INFO'];

let c;
const T1 = '00000000-0000-0000-0000-0000000000a1';
const T2 = '00000000-0000-0000-0000-0000000000a2';
// withTenant injetável p/ loadStages: filtra por tenant no client efêmero (sem RLS).
const fakeWithTenant = (tid, fn) => fn({
  query: (sql, params) => c.query(sql.replace('tenant_id = $1', 'tenant_id = $1'), params),
});

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  // O setup precisa espelhar o que o SQL GERADO referencia, não só o que o teste lê. Faltavam
  // `desfecho_em` e a tabela `lead_manager.extranet_lead` (o EXISTS de _fatoExp em stages.js usa o
  // schema explícito), e os três testes do carimbo morriam no setup — 42P01/42703 — sem nunca
  // chegar às asserções. Eu escrevi este arquivo sem Postgres na máquina e o dei como cobertura.
  await c.query(`
    CREATE SCHEMA IF NOT EXISTS lead_manager;
    CREATE TABLE leads (id serial PRIMARY KEY, tenant_id uuid, status text, desfecho text,
                        intent text, desfecho_em timestamptz);
    CREATE TABLE lead_manager.extranet_lead (
      id serial PRIMARY KEY, tenant_id uuid, extranet_id text, lead_id int,
      situacao text, exp_agendada_em timestamptz, exp_realizada_em timestamptz);
    CREATE TABLE tenant_lead_config (tenant_id uuid PRIMARY KEY, stage_definitions jsonb);
    -- migr 129: os baldes do funil passaram a consultar a agenda da Extranet. Sem esta tabela o SQL
    -- gerado morre com 42P01 no setup — a mesma armadilha descrita logo acima.
    CREATE TABLE lead_manager.aula_experimental (
      id serial PRIMARY KEY, tenant_id uuid, aula_id text, lead_id int, status_cod int);`);
  // todas as combinações status×desfecho×intent → cobertura total da partição e do funil.
  for (const s of STATUSES) for (const d of DESFECHOS) for (const i of INTENTS) {
    await c.query('INSERT INTO leads (tenant_id, status, desfecho, intent) VALUES ($1,$2,$3,$4)', [T1, s, d, i]);
  }
  // config só do T1 (T2 fica SEM linha → default puro).
  await c.query(`INSERT INTO tenant_lead_config (tenant_id, stage_definitions)
    VALUES ($1, $2::jsonb)`, [T1, JSON.stringify({ experimental: 'DEF experimental do tenant', qualificado: 'DEF qualificado' })]);
});
after(async () => { await c.end(); });

test('(1) stageKey/stageOfLead == kanbanColuna ANTIGO em TODAS as combinações', () => {
  let n = 0;
  for (const s of STATUSES) for (const d of DESFECHOS) {
    assert.equal(stageKey(s, d), kanbanColunaOLD(s, d), `stageKey(${s},${d})`);
    assert.equal(stageOfLead({ status: s, desfecho: d }), kanbanColunaOLD(s, d), `stageOfLead(${s},${d})`);
    n++;
  }
  assert.ok(n === STATUSES.length * DESFECHOS.length);
});

test('(2) stageSql ≡ stageOfLead (SQL == JS) linha a linha na base', async () => {
  const rows = (await c.query(`SELECT id, status, desfecho, ${stageSql('l')} AS sql_stage FROM leads l`)).rows;
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.sql_stage, stageOfLead(r), `SQL≡JS falhou p/ status=${r.status} desfecho=${r.desfecho}`);
  }
});

test('(3) funilBucketSql: Passo 2 UNE fato+proxy — nunca conta menos que o proxy SEM o intent', async () => {
  const cnt = async (frag) => (await c.query(`SELECT count(*)::int n FROM leads WHERE ${frag}`)).rows[0].n;
  // A união é MONOTÔNICA em relação ao proxy de AGENDAMENTO REAL (status/no-show): quem contava por
  // ele continua contando, e o carimbo da Extranet adiciona quem a conversão apagou.
  //
  // ⚠ Até 2026-09-18 a comparação era com OLD_AGENDADA, que incluía intent='SCHEDULE_INTEREST'. Esse
  // intent é a IA percebendo que a pessoa QUER marcar — não que marcou. Ele saiu do proxy (35 dos 123
  // "agendados" de 6 meses eram só interesse, e a taxa agendada→realizada caía para 33% contra os
  // 63–78% da agenda da Extranet). Então aqui a régua antiga é comparada SEM esse termo, e o (3g)
  // trava o contrário: interesse sozinho NÃO conta.
  const AGENDAMENTO_REAL = "status = 'EXPERIMENTAL_AGENDADA' OR desfecho = 'nao_compareceu_aula'";
  const REALIZADA_REAL = `(${AGENDAMENTO_REAL}) AND desfecho IS NOT NULL AND desfecho <> 'nao_compareceu_aula'`;
  assert.ok(await cnt(funilBucketSql('experimental')) >= await cnt(AGENDAMENTO_REAL), 'agendadas ⊇ agendamento real');
  assert.ok(await cnt(funilBucketSql('realizada')) >= await cnt(REALIZADA_REAL), 'realizadas ⊇ proxy real');
  // E o antigo CONTAVA MAIS — exatamente os leads só com intent. A diferença tem de existir,
  // senão o teste não está exercitando a mudança.
  assert.ok(await cnt(OLD_AGENDADA) > await cnt(funilBucketSql('experimental')),
    'o proxy antigo contava mais (o intent inflava) — sem diferença, a base não cobre o caso');
  // 'convertido' TAMBÉM une desde 2026-08-28 (fato 'Ganhou' da Extranet ∪ desfecho preenchido).
  // Sem linha no espelho a união colapsa no proxy, então aqui a igualdade ainda vale — o caso com
  // fato é exercitado no (3d), que semeia o 'Ganhou'.
  assert.equal(await cnt(funilBucketSql('convertido')), await cnt(OLD_MATRICULA),
    'sem fato no espelho, matrículas seguem idênticas ao proxy');
  // sanidade: o teste tem sinal (não está medindo conjunto vazio).
  assert.ok(await cnt(funilBucketSql('experimental')) > 0, 'agendadas > 0 (senão o teste é vazio)');
});

test('(3b) invariante do funil: realizadas ⊆ agendadas (o encadeamento não pode passar de 100%)', async () => {
  // O bug que o Passo 2 conserta produzia agendadas≈0 com matrículas>0 → taxa acima de 100%.
  // Aqui a garantia é estrutural: todo lead do bucket "realizada" tem de estar em "agendada",
  // tanto pelo lado do fato (exp_realizada_em só é carimbado junto de exp_agendada_em) quanto
  // pelo lado do proxy (o negativo é uma restrição do próprio proxy de agendada).
  const fora = (await c.query(
    `SELECT count(*)::int n FROM leads
      WHERE (${funilBucketSql('realizada')}) AND NOT (${funilBucketSql('experimental')})`)).rows[0].n;
  assert.equal(fora, 0, 'nenhum lead pode ser "realizada" sem ser "agendada"');
});

test('(3c) o carimbo da Extranet resiste à conversão (a matrícula não apaga a aula)', async () => {
  // Regressão do bug raiz: o move para "convertido" sobrescreve status=CONVERTED, o lead sai do
  // _experimentalProxy e sumia de agendadas/realizadas continuando em matrículas.
  const { rows: [lead] } = await c.query(
    `INSERT INTO leads (tenant_id, status, desfecho, desfecho_em)
     VALUES ($1, 'CONVERTED', 'matriculado', now()) RETURNING id`, [T1]);
  try {
    // sem carimbo: o proxy não segura (é exatamente o buraco que o Passo 2 fecha)
    const semCarimbo = async (k) => (await c.query(
      `SELECT count(*)::int n FROM leads WHERE id=$1 AND (${funilBucketSql(k)})`, [lead.id])).rows[0].n;
    assert.equal(await semCarimbo('realizada'), 0, 'sem fato, o proxy perde o lead convertido');

    await c.query(
      `INSERT INTO lead_manager.extranet_lead (tenant_id, extranet_id, lead_id, situacao, exp_agendada_em, exp_realizada_em)
       VALUES ($1, $2, $3, 'Ganhou', now(), now())`,
      [T1, `itest-${lead.id}`, lead.id]);
    // com carimbo: conta, mesmo com a situacao já sobrescrita para 'Ganhou'
    assert.equal(await semCarimbo('experimental'), 1, 'fato recupera agendadas');
    assert.equal(await semCarimbo('realizada'), 1, 'fato recupera realizadas');
  } finally {
    await c.query('DELETE FROM lead_manager.extranet_lead WHERE lead_id=$1', [lead.id]);
    await c.query('DELETE FROM leads WHERE id=$1', [lead.id]);
  }
});

test('(3d) matrícula pelo FATO da Extranet: "Ganhou" conta mesmo sem desfecho preenchido', async () => {
  // POR QUE (medido em produção, 2026-08-28): 86% a 90% dos leads com aula experimental estão SEM
  // desfecho preenchido no Regente (44 de 49 em 'Exp. Agendada', 18 de 21 em 'Exp. Realizada'). A
  // recepção atende e não fecha o registro. Depender só do preenchimento fazia o funil medir quem
  // lembrou de preencher, não quem converteu.
  const { rows: [lead] } = await c.query(
    `INSERT INTO leads (tenant_id, status, desfecho) VALUES ($1,'QUALIFYING',NULL) RETURNING id`, [T1]);
  const conta = async (k) => (await c.query(
    `SELECT count(*)::int n FROM leads WHERE id=$1 AND (${funilBucketSql(k)})`, [lead.id])).rows[0].n;
  try {
    assert.equal(await conta('convertido'), 0, 'sem fato e sem desfecho: não é matrícula');
    await c.query(
      `INSERT INTO lead_manager.extranet_lead (tenant_id, extranet_id, lead_id, situacao)
       VALUES ($1,$2,$3,'Ganhou')`, [T1, `itest-ganhou-${lead.id}`, lead.id]);
    assert.equal(await conta('convertido'), 1, '"Ganhou" na Extranet É matrícula');
  } finally {
    await c.query('DELETE FROM lead_manager.extranet_lead WHERE lead_id=$1', [lead.id]);
    await c.query('DELETE FROM leads WHERE id=$1', [lead.id]);
  }
});

test('(3e) o rótulo da Extranet é texto livre: acento e caixa não podem derrubar o fato', async () => {
  // 'situacao' vem do <select> da tela — texto livre. 'Matrícula' com acento e caixa alta tem de
  // valer tanto quanto 'ganhou'. Sem normalizar, o fato sumia em silêncio (o pior modo de falhar).
  const { rows: [lead] } = await c.query(
    `INSERT INTO leads (tenant_id, status) VALUES ($1,'QUALIFYING') RETURNING id`, [T1]);
  try {
    for (const rotulo of ['Matrícula', 'GANHOU', 'matriculado']) {
      await c.query(`DELETE FROM lead_manager.extranet_lead WHERE lead_id=$1`, [lead.id]);
      await c.query(
        `INSERT INTO lead_manager.extranet_lead (tenant_id, extranet_id, lead_id, situacao)
         VALUES ($1,$2,$3,$4)`, [T1, `itest-rot-${lead.id}`, lead.id, rotulo]);
      const n = (await c.query(
        `SELECT count(*)::int n FROM leads WHERE id=$1 AND (${funilBucketSql('convertido')})`,
        [lead.id])).rows[0].n;
      assert.equal(n, 1, `"${rotulo}" tem de contar como matrícula`);
    }
    // e o contrário: rótulo que NÃO é matrícula não pode virar matrícula por parecer.
    await c.query(`DELETE FROM lead_manager.extranet_lead WHERE lead_id=$1`, [lead.id]);
    await c.query(
      `INSERT INTO lead_manager.extranet_lead (tenant_id, extranet_id, lead_id, situacao)
       VALUES ($1,$2,$3,'Perdeu')`, [T1, `itest-rot-${lead.id}`, lead.id]);
    const n = (await c.query(
      `SELECT count(*)::int n FROM leads WHERE id=$1 AND (${funilBucketSql('convertido')})`,
      [lead.id])).rows[0].n;
    assert.equal(n, 0, '"Perdeu" não é matrícula');
  } finally {
    await c.query('DELETE FROM lead_manager.extranet_lead WHERE lead_id=$1', [lead.id]);
    await c.query('DELETE FROM leads WHERE id=$1', [lead.id]);
  }
});

test('(3f) temFatoExtranetSql: é a EXCEÇÃO ao descarte do classificador', async () => {
  // O funil exclui NOT_LEAD/REVIEW_QUEUE. Certo para quem o gate descartou de verdade, ERRADO para
  // quem ele descartou por engano: em produção, dos 44 leads marcados NOT_LEAD com linha no
  // espelho, 20 marcaram aula, 8 fizeram a aula e 6 estão em 'Ganhou'. Fato vence classificação.
  const { rows: [lead] } = await c.query(
    `INSERT INTO leads (tenant_id, status) VALUES ($1,'NOT_LEAD') RETURNING id`, [T1]);
  const passaNoFunil = async () => (await c.query(
    `SELECT count(*)::int n FROM leads
      WHERE id=$1 AND (status NOT IN ('NOT_LEAD','REVIEW_QUEUE') OR ${temFatoExtranetSql()})`,
    [lead.id])).rows[0].n;
  try {
    assert.equal(await passaNoFunil(), 0, 'NOT_LEAD sem rastro segue fora do funil');
    await c.query(
      `INSERT INTO lead_manager.extranet_lead (tenant_id, extranet_id, lead_id, situacao, exp_agendada_em)
       VALUES ($1,$2,$3,'Exp. Agendada', now())`, [T1, `itest-fp-${lead.id}`, lead.id]);
    assert.equal(await passaNoFunil(), 1, 'marcou aula na Extranet → é lead, mesmo marcado NOT_LEAD');
  } finally {
    await c.query('DELETE FROM lead_manager.extranet_lead WHERE lead_id=$1', [lead.id]);
    await c.query('DELETE FROM leads WHERE id=$1', [lead.id]);
  }
});

test('(4) isStage + de-para status↔coluna estáveis', () => {
  assert.equal(isStage({ status: 'EXPERIMENTAL_AGENDADA', desfecho: null }, 'experimental'), true);
  assert.equal(isStage({ status: 'QUALIFYING', desfecho: 'matriculado' }, 'convertido'), true, 'desfecho vence status');
  assert.deepEqual(STATUS_TO_KEY, { QUALIFYING: 'qualificando', QUALIFIED: 'qualificado', EXPERIMENTAL_AGENDADA: 'experimental', CONVERTED: 'convertido', PERDIDO: 'perdido' });
  assert.equal(KEY_TO_STATUS.experimental, 'EXPERIMENTAL_AGENDADA');
  // 'novo' NÃO é destino de arraste (fora do de-para), como no _KANBAN_DEST_COL antigo.
  assert.ok(!('novo' in KEY_TO_STATUS));
  // transições: full-mesh nas etapas de trabalho; 'novo' só origem.
  assert.deepEqual(KANBAN_TRANSICOES.experimental, ['qualificando', 'qualificado', 'convertido', 'perdido']);
  assert.ok(!KANBAN_TRANSICOES.qualificando.includes('novo'), 'novo nunca é destino');
});

test('(5) loadStages: default sem config; funde defs do tenant; multi-tenant isolado', async () => {
  const t1 = await loadStages(T1, { withTenant: fakeWithTenant });
  const t2 = await loadStages(T2, { withTenant: fakeWithTenant });
  const byKey = (arr) => Object.fromEntries(arr.map((s) => [s.key, s]));
  const a = byKey(t1), b = byKey(t2);
  // T1 tem defs → merge; T2 sem linha → default puro (todas definition=null).
  assert.equal(a.experimental.definition, 'DEF experimental do tenant');
  assert.equal(a.qualificado.definition, 'DEF qualificado');
  assert.equal(a.novo.definition, null, 'chave sem def no tenant fica null');
  for (const s of t2) assert.equal(s.definition, null, `T2 default: ${s.key} sem def`);
  // isolamento: a régua (keys/ordem/status) é a mesma; só as descrições variam por tenant.
  assert.deepEqual(t1.map((s) => s.key), t2.map((s) => s.key));
  // multi-tenant sem vazamento: T2 não herda as defs do T1.
  assert.notEqual(b.experimental.definition, 'DEF experimental do tenant');
});

test('(6) loadStages sem tabela/erro → default puro (degrada elegante)', async () => {
  const boom = () => { throw new Error('sem config'); };
  const out = await loadStages(T1, { withTenant: boom });
  assert.equal(out.length, 8, 'régua completa (inclui realizada funil-only e cliente pré-existente/079)');
  for (const s of out) assert.equal(s.definition, null);
  assert.deepEqual(PERDIDO_DESFECHOS.includes('nao_compareceu_aula'), true);
});

test('(3g) INTERESSE em marcar não é aula agendada (2026-09-18)', async () => {
  // intent='SCHEDULE_INTEREST' é a IA percebendo "quero marcar uma aula". Até 2026-09-18 isso
  // contava como aula agendada, e 35 dos 123 "agendados" de 6 meses eram só interesse. A taxa
  // agendada→realizada caía para 33% contra 63–78% da agenda real da Extranet.
  const { rows: [lead] } = await c.query(
    `INSERT INTO leads (tenant_id, status, intent) VALUES ($1,'QUALIFYING','SCHEDULE_INTEREST') RETURNING id`, [T1]);
  const conta = async (k) => (await c.query(
    `SELECT count(*)::int n FROM leads WHERE id=$1 AND (${funilBucketSql(k)})`, [lead.id])).rows[0].n;
  try {
    assert.equal(await conta('experimental'), 0, 'só interesse, sem aula marcada: NÃO é agendada');
    // quando a aula é marcada de verdade (fato da Extranet), passa a contar
    await c.query(
      `INSERT INTO lead_manager.extranet_lead (tenant_id, extranet_id, lead_id, situacao, exp_agendada_em)
       VALUES ($1,$2,$3,'Exp. Agendada', now())`, [T1, `itest-int-${lead.id}`, lead.id]);
    assert.equal(await conta('experimental'), 1, 'com aula marcada na Extranet: é agendada');
  } finally {
    await c.query('DELETE FROM lead_manager.extranet_lead WHERE lead_id=$1', [lead.id]);
    await c.query('DELETE FROM leads WHERE id=$1', [lead.id]);
  }
});

test('(3h) marcou aula E matriculou = aula realizada, mesmo sem o carimbo de realizada', async () => {
  // O carimbo exp_realizada_em só nasce se o sync de 3h FLAGRAR 'Exp. Realizada'; quem matricula logo
  // depois da aula pula direto para 'Ganhou'. Medido: dos 15 que marcaram e matricularam, só 4
  // tinham o carimbo. Marcou + matriculou prova que a aula aconteceu.
  const { rows: [lead] } = await c.query(
    `INSERT INTO leads (tenant_id, status) VALUES ($1,'QUALIFYING') RETURNING id`, [T1]);
  const conta = async (k) => (await c.query(
    `SELECT count(*)::int n FROM leads WHERE id=$1 AND (${funilBucketSql(k)})`, [lead.id])).rows[0].n;
  try {
    // marcou, ainda não matriculou, sem carimbo de realizada: NÃO é realizada
    await c.query(
      `INSERT INTO lead_manager.extranet_lead (tenant_id, extranet_id, lead_id, situacao, exp_agendada_em)
       VALUES ($1,$2,$3,'Exp. Agendada', now())`, [T1, `itest-mr-${lead.id}`, lead.id]);
    assert.equal(await conta('realizada'), 0, 'só marcou: não dá para afirmar que a aula aconteceu');
    // matriculou (situação vira Ganhou, carimbo de agendada permanece)
    await c.query(`UPDATE lead_manager.extranet_lead SET situacao='Ganhou' WHERE lead_id=$1`, [lead.id]);
    assert.equal(await conta('realizada'), 1, 'marcou + matriculou = realizada');
    assert.equal(await conta('experimental'), 1, 'e continua agendada (realizada ⊆ agendada)');
  } finally {
    await c.query('DELETE FROM lead_manager.extranet_lead WHERE lead_id=$1', [lead.id]);
    await c.query('DELETE FROM leads WHERE id=$1', [lead.id]);
  }
});

// ---- AGENDA DA EXTRANET (migr 129, 2026-09-18) -------------------------------------------------
// A fonte que não deduz: uma linha por aula experimental, com o resultado em código.
const aula = (leadId, cod) => c.query(
  `INSERT INTO lead_manager.aula_experimental (tenant_id, aula_id, lead_id, status_cod) VALUES ($1,$2,$3,$4)`,
  [T1, `itest-aula-${leadId}-${cod}`, leadId, cod]);
const umLead = async () => (await c.query(
  `INSERT INTO leads (tenant_id, status) VALUES ($1,'QUALIFYING') RETURNING id`, [T1])).rows[0].id;
const contaLead = async (id, k) => (await c.query(
  `SELECT count(*)::int n FROM leads WHERE id=$1 AND (${funilBucketSql(k)})`, [id])).rows[0].n;
const limpa = async (id) => {
  await c.query('DELETE FROM lead_manager.aula_experimental WHERE lead_id=$1', [id]);
  await c.query('DELETE FROM lead_manager.extranet_lead WHERE lead_id=$1', [id]);
  await c.query('DELETE FROM leads WHERE id=$1', [id]);
};

test('(3i) agenda: aula realizada conta como agendada E realizada; cancelada só como agendada', async () => {
  const realizou = await umLead(); const cancelou = await umLead();
  try {
    await aula(realizou, 200);
    await aula(cancelou, 310);
    assert.equal(await contaLead(realizou, 'experimental'), 1, 'realizada é agendada');
    assert.equal(await contaLead(realizou, 'realizada'), 1, '200 = realizada');
    assert.equal(await contaLead(cancelou, 'experimental'), 1, 'cancelou, mas MARCOU: é agendada');
    assert.equal(await contaLead(cancelou, 'realizada'), 0, '310 (cancelada pelo aluno) não é realizada');
    for (const cod of [210, 220, 230]) {
      const l = await umLead();
      try { await aula(l, cod); assert.equal(await contaLead(l, 'realizada'), 1, `${cod} é realizada`); }
      finally { await limpa(l); }
    }
  } finally { await limpa(realizou); await limpa(cancelou); }
});

test('(3j) agenda MANDA sobre a presunção "marcou + matriculou"', async () => {
  // A presunção da correção rápida existe para quem não tem registro na agenda. Havendo registro, o
  // código decide — aqui a pessoa cancelou a aula e matriculou mesmo assim: NÃO houve aula.
  const l = await umLead();
  try {
    await c.query(`INSERT INTO lead_manager.extranet_lead (tenant_id, extranet_id, lead_id, situacao, exp_agendada_em)
      VALUES ($1,$2,$3,'Ganhou', now())`, [T1, `itest-pres-${l}`, l]);
    assert.equal(await contaLead(l, 'realizada'), 1, 'sem agenda: vale a presunção');
    await aula(l, 310);
    assert.equal(await contaLead(l, 'realizada'), 0, 'com agenda dizendo cancelada: não é realizada');
  } finally { await limpa(l); }
});

test('(3k) agenda: "Realizada com matrícula posterior" (220) é matrícula', async () => {
  const l = await umLead();
  try {
    assert.equal(await contaLead(l, 'convertido'), 0);
    await aula(l, 220);
    assert.equal(await contaLead(l, 'convertido'), 1, '220 = a própria Extranet ligando aula → matrícula');
    await c.query('DELETE FROM lead_manager.aula_experimental WHERE lead_id=$1', [l]);
    await aula(l, 200);
    assert.equal(await contaLead(l, 'convertido'), 0, '200 (realizada sem matrícula) não é matrícula');
  } finally { await limpa(l); }
});

test('(3l) agenda: aula registrada também é FATO que tira o lead do descarte', async () => {
  const { rows: [l] } = await c.query(`INSERT INTO leads (tenant_id, status) VALUES ($1,'NOT_LEAD') RETURNING id`, [T1]);
  try {
    const fato = async () => (await c.query(`SELECT count(*)::int n FROM leads WHERE id=$1 AND ${temFatoExtranetSql('leads')}`, [l.id])).rows[0].n;
    assert.equal(await fato(), 0);
    await aula(l.id, 100);
    assert.equal(await fato(), 1, 'quem marcou aula É lead, mesmo que o classificador tenha descartado');
  } finally { await limpa(l.id); }
});

test('(3m) invariante segue valendo com a agenda: realizadas ⊆ agendadas', async () => {
  const ls = [];
  try {
    for (const cod of [0, 100, 200, 210, 220, 230, 300, 305, 310, 320]) { const l = await umLead(); ls.push(l); await aula(l, cod); }
    const fora = (await c.query(
      `SELECT count(*)::int n FROM leads WHERE (${funilBucketSql('realizada')}) AND NOT (${funilBucketSql('experimental')})`)).rows[0].n;
    assert.equal(fora, 0);
  } finally { for (const l of ls) await limpa(l); }
});
