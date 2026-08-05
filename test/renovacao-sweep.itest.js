'use strict';
// renovacao-sweep.itest.js — Renovação Fase 1 (migration 091 + jobs/renovacao-sweep).
// PG DESCARTÁVEL (schema lead_manager + cadastro 060/072 + automacao_config/tenant_lead_config +
// renovacao_touchpoint). Sem Extranet e SEM Gemini real (injeta um fake). Cobre: marca D-10 e D-2 pela
// distância até fim_vigencia (dias corridos); destinatário = pagador (senão aluno) + telefone; passa a
// data/marco certos à Janis; idempotência (UNIQUE); toggle renovacao_habilitada; contrato sem telefone
// não enfileira; contrato fora dos marcos ignorado; previsão agrupa por faixa.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, withTenant } = require('../src/db');
const sweep = require('../src/jobs/renovacao-sweep');

const A = process.env.RESOURCES_TENANT_A;
const B = process.env.RESOURCES_TENANT_B;

// Gemini fake: registra as chamadas e devolve rascunho determinístico.
function fakeGemini() {
  const calls = [];
  return {
    calls,
    sugestaoRenovacao: async (args) => {
      calls.push(args);
      return { estrategia: `est-${args.marco}`, rascunho: `Rascunho ${args.marco} — encerra em ${args.dataFimISO}` };
    },
  };
}

let SEQ = 0;
async function seedPerson(t, name) {
  return withTenant(t, async (c) =>
    (await c.query(`INSERT INTO lead_manager.person (tenant_id, display_name) VALUES ($1,$2) RETURNING id`, [t, name])).rows[0].id);
}
async function seedPhone(t, personId, phone) {
  await withTenant(t, (c) => c.query(
    `INSERT INTO lead_manager.contact_point (tenant_id, person_id, kind, value_raw, source, confidence, tipo)
     VALUES ($1,$2,'phone',$3,'extranet','provado','cadastro')`, [t, personId, phone]));
}
// finDias: fim_vigencia = current_date + finDias (garante alinhamento com (fim - current_date) do job).
async function seedContract(t, { finDias, servico = 'Bateria', status = 'ativo', aluno, alunoPhone, pagador, pagadorPhone } = {}) {
  const accId = await withTenant(t, async (c) =>
    (await c.query(
      `INSERT INTO lead_manager.service_account (tenant_id, status, servico_label, ini_vigencia, fim_vigencia)
       VALUES ($1,$2,$3, current_date - 90, current_date + $4::int) RETURNING id`, [t, status, servico, finDias])).rows[0].id);
  const add = async (name, ph, bond) => {
    const pid = await seedPerson(t, name);
    if (ph) await seedPhone(t, pid, ph);
    await withTenant(t, (c) => c.query(
      `INSERT INTO lead_manager.account_member (tenant_id, account_id, person_id, bond) VALUES ($1,$2,$3,$4)`, [t, accId, pid, bond]));
  };
  if (aluno) await add(aluno, alunoPhone, 'beneficiario');
  if (pagador) await add(pagador, pagadorPhone, 'pagador');
  return accId;
}
async function setCfg(t, { habilitada = true, auto = false, nomeIa = 'Janis', contexto = 'Escola de música em Valinhos' } = {}) {
  await withTenant(t, (c) => c.query(
    `INSERT INTO lead_manager.automacao_config (tenant_id, nome_ia, contexto_ia, renovacao_habilitada, renovacao_auto_envio)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id) DO UPDATE SET nome_ia=$2, contexto_ia=$3, renovacao_habilitada=$4, renovacao_auto_envio=$5`,
    [t, nomeIa, contexto, habilitada, auto]));
}
const tpsOf = (t, accId) => withTenant(t, async (c) =>
  (await c.query(`SELECT marco, phone, destinatario_nome, aluno_nome, servico_label, status, rascunho, estrategia,
                         to_char(fim_vigencia,'YYYY-MM-DD') fim, to_char(due_date,'YYYY-MM-DD') due
                    FROM lead_manager.renovacao_touchpoint WHERE tenant_id=$1 AND account_id=$2 ORDER BY marco`, [t, accId])).rows);

after(async () => { await pool.end(); try { require('../src/redisClient').redis.disconnect(); } catch {} });

// ---------- D-10 e D-2: marca certo, destinatário = pagador, data passada à Janis ----------
test('R1 pagador com contrato em D-10 → 1 touchpoint D-10 pendente, com rascunho da Janis', async () => {
  await setCfg(A);
  const acc = await seedContract(A, { finDias: 10, servico: 'Guitarra', aluno: 'Filho', pagador: 'Mãe Responsável', pagadorPhone: '5519990001001' });
  const g = fakeGemini();
  const r = await sweep.processarTenant(A, { gemini: g });
  assert.equal(r.enfileirados, 1); assert.equal(r['D-10'], 1); assert.equal(r['D-2'], 0);
  const tps = await tpsOf(A, acc);
  assert.equal(tps.length, 1);
  assert.equal(tps[0].marco, 'D-10');
  assert.equal(tps[0].status, 'pendente');
  assert.equal(tps[0].phone, '5519990001001', 'telefone do PAGADOR');
  assert.equal(tps[0].destinatario_nome, 'Mãe Responsável');
  assert.equal(tps[0].aluno_nome, 'Filho');
  assert.equal(tps[0].servico_label, 'Guitarra');
  assert.match(tps[0].rascunho, /encerra em/);
  // a Janis recebeu o marco e a data de fim corretos
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].marco, 'D-10');
  assert.equal(g.calls[0].responsavelNome, 'Mãe Responsável');
  assert.equal(g.calls[0].dataFimISO, tps[0].fim);
});

// ---------- D-2 e destinatário = aluno quando não há pagador ----------
test('R2 aluno (sem pagador) com contrato em D-2 → touchpoint D-2 com telefone do aluno', async () => {
  await setCfg(A);
  const acc = await seedContract(A, { finDias: 2, servico: 'Canto', aluno: 'Aluno Solo', alunoPhone: '5519990002002' });
  const g = fakeGemini();
  const r = await sweep.processarTenant(A, { gemini: g });
  assert.equal(r['D-2'] >= 1, true);
  const tps = await tpsOf(A, acc);
  assert.equal(tps.length, 1); assert.equal(tps[0].marco, 'D-2');
  assert.equal(tps[0].phone, '5519990002002');
  assert.equal(tps[0].destinatario_nome, 'Aluno Solo');
  assert.equal(g.calls.find((x) => x.dataFimISO === tps[0].fim).responsavelNome, null, 'sem pagador → sem responsável nomeado');
});

// ---------- idempotência ----------
test('R3 rodar 2x não duplica (UNIQUE por marco/âncora)', async () => {
  await setCfg(A);
  const acc = await seedContract(A, { finDias: 10, aluno: 'Idem', alunoPhone: '5519990003003' });
  await sweep.processarTenant(A, { gemini: fakeGemini() });
  const g2 = fakeGemini();
  const r2 = await sweep.processarTenant(A, { gemini: g2 });
  const meus = (await tpsOf(A, acc));
  assert.equal(meus.length, 1, 'continua 1 touchpoint');
  assert.equal(g2.calls.some((x) => x.dataFimISO === meus[0].fim), false, 'nem chama a Janis de novo p/ o já-enfileirado');
});

// ---------- toggle desligado ----------
test('R4 renovacao_habilitada=false → não varre nem enfileira', async () => {
  await setCfg(B, { habilitada: false });
  const acc = await seedContract(B, { finDias: 10, aluno: 'Desab', alunoPhone: '5519990004004' });
  const r = await sweep.processarTenant(B, { gemini: fakeGemini() });
  assert.equal(r.skipped, 'desabilitada');
  assert.equal((await tpsOf(B, acc)).length, 0);
});

// ---------- sem telefone não enfileira ----------
test('R5 contrato em D-10 sem telefone → não enfileira, conta em sem_telefone', async () => {
  await setCfg(A);
  const acc = await seedContract(A, { finDias: 10, aluno: 'Sem Fone' });   // sem alunoPhone
  const r = await sweep.processarTenant(A, { gemini: fakeGemini() });
  assert.equal((await tpsOf(A, acc)).length, 0);
  assert.equal(r.sem_telefone >= 1, true);
});

// ---------- fora dos marcos é ignorado ----------
test('R6 contrato em D-5 (fora de {10,2}) não gera touchpoint', async () => {
  await setCfg(A);
  const acc = await seedContract(A, { finDias: 5, aluno: 'Meio', alunoPhone: '5519990006006' });
  await sweep.processarTenant(A, { gemini: fakeGemini() });
  assert.equal((await tpsOf(A, acc)).length, 0);
});

// ---------- contrato cancelado é ignorado ----------
test('R7 contrato cancelado em D-10 não gera touchpoint', async () => {
  await setCfg(A);
  const acc = await seedContract(A, { finDias: 10, status: 'cancelado', aluno: 'Cancelado', alunoPhone: '5519990007007' });
  await sweep.processarTenant(A, { gemini: fakeGemini() });
  assert.equal((await tpsOf(A, acc)).length, 0);
});

// ---------- previsão agrupa por faixa (não envia nada) ----------
test('R8 renovacaoPrevisao agrupa por faixa dentro do horizonte', async () => {
  // tenant dedicado (B com habilitada=false, mas previsão não depende do toggle)
  await seedContract(B, { finDias: 2, aluno: 'P2', alunoPhone: '5519990008001' });
  await seedContract(B, { finDias: 10, aluno: 'P10', alunoPhone: '5519990008002' });
  await seedContract(B, { finDias: 18, aluno: 'P18', alunoPhone: '5519990008003' });
  await seedContract(B, { finDias: 40, aluno: 'P40', alunoPhone: '5519990008004' });
  const prev = await sweep.renovacaoPrevisao(B, { horizonteDias: 45 });
  assert.equal(prev.total >= 4, true);
  assert.equal(prev.buckets['D-2'] >= 1, true);
  assert.equal(prev.buckets['D-10'] >= 1, true);
  assert.equal(prev.buckets['11-20d'] >= 1, true);
  assert.equal(prev.buckets['31d+'] >= 1, true);
  // fora do horizonte não conta
  await seedContract(B, { finDias: 90, aluno: 'P90', alunoPhone: '5519990008005' });
  const prev2 = await sweep.renovacaoPrevisao(B, { horizonteDias: 45 });
  assert.equal(prev2.contratos.every((c) => c.dias <= 45), true);
});

// ---------- Fase 2: envio automático (send mockado; sem Evolution real) ----------
test('R9 auto-envio ON: dispara pendentes (mock), marca enviado(auto), respeita o cap diário', async () => {
  await setCfg(B, { habilitada: true, auto: true });          // liga a varredura E o automático em B
  await sweep.processarTenant(B, { gemini: fakeGemini() });   // enfileira os D-10/D-2 de B (>=2)
  const sent = [];
  const r = await sweep.autoEnviarTenant(B, {
    send: async (tid, tp) => { sent.push(tp.id); return { ok: true }; },
    throttleMs: 0, capDia: 2,
  });
  assert.equal(r.enviados, 2, 'envia no máximo o cap (2)');
  assert.equal(sent.length, 2);
  const enviadosAuto = await withTenant(B, async (c) => (await c.query(
    `SELECT count(*)::int AS n FROM lead_manager.renovacao_touchpoint
      WHERE tenant_id=$1 AND status='enviado' AND auto=true`, [B])).rows[0].n);
  assert.equal(enviadosAuto, 2, 'marcou 2 como enviado(auto)');
});

test('R10 auto-envio OFF: não dispara nada', async () => {
  await setCfg(A, { auto: false });
  const r = await sweep.autoEnviarTenant(A, {
    send: async () => { throw new Error('não deveria enviar com o toggle desligado'); },
    throttleMs: 0,
  });
  assert.equal(r.skipped, 'auto_off');
});
