'use strict';
// contract-convert.itest.js — CONVERTIDO POR ORIGEM + ESTADO "CLIENTE" (migration 079).
// Prova ISOLADA (PG descartável, schema lead_manager + RLS no cadastro). Sem Extranet: contratos sintéticos.
// Cobre a régua de ORIGEM (1ª mensagem vs matrícula ORIGINAL, com janela por-tenant): lead→contrato em 3
// dias → convertido; contrato anos antes → cliente (não conversão); veterano que RENOVA depois de mandar
// mensagem (Vanessa) → cliente; borda da janela dos 7 dias (dentro/fora); marco = 1ª mensagem e não
// created_at; taxa conta só quem nasceu no funil; papéis (aluno/responsável); latch humano; matrícula
// humana nunca vira cliente; lead vivo não é marcado cliente sozinho; fila + confirmar; reverter; multi-tenant.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, withTenant } = require('../src/db');
const cc = require('../src/cadastro/contractConvert');
const stages = require('../src/stages');

const A = process.env.RESOURCES_TENANT_A;
const B = process.env.RESOURCES_TENANT_B;

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
async function seedContract(t, { ini, fim, servico = 'Piano', aluno, alunoPhone, pagador, pagadorPhone } = {}) {
  const accId = await withTenant(t, async (c) =>
    (await c.query(`INSERT INTO lead_manager.service_account (tenant_id, status, servico_label, ini_vigencia, fim_vigencia)
                    VALUES ($1,'Não Contatado',$2,$3,$4) RETURNING id`, [t, servico, ini, fim])).rows[0].id);
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
async function seedLead(t, { name, phone = '', status = 'QUALIFYING', desfecho = null, reviewResult = null, reviewBy = null, createdAt = null } = {}) {
  return withTenant(t, async (c) =>
    (await c.query(`INSERT INTO lead_manager.leads (tenant_id, name, phone, status, desfecho, review_result, review_by, created_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now())) RETURNING id`,
      [t, `${name} #${++SEQ}`, phone, status, desfecho, reviewResult, reviewBy, createdAt])).rows[0].id);
}
// Conversa com a PRIMEIRA MENSAGEM em `msg1` — é o marco de "virou lead no Regente".
async function seedConversa(t, phone, msg1, { extras = [] } = {}) {
  await withTenant(t, async (c) => {
    const cv = (await c.query(
      `INSERT INTO lead_manager.conversations (tenant_id, channel, external_id) VALUES ($1,'whatsapp',$2) RETURNING id`,
      [t, phone])).rows[0].id;
    for (const d of [msg1, ...extras]) {
      await c.query(`INSERT INTO lead_manager.messages (tenant_id, conversation_id, direction, body, received_at, role)
                     VALUES ($1,$2,'inbound','oi',$3::timestamptz,'USER')`, [t, cv, d]);
    }
  });
}
const leadOf = (t, id) => withTenant(t, async (c) =>
  (await c.query(`SELECT status, desfecho, to_char(desfecho_em,'YYYY-MM-DD') d FROM lead_manager.leads WHERE id=$1`, [id])).rows[0]);
const logOf = (t, id) => withTenant(t, async (c) =>
  (await c.query(`SELECT * FROM lead_manager.stage_autoapply_log WHERE lead_id=$1 ORDER BY created_at DESC`, [id])).rows);
const pendOf = (t, id) => withTenant(t, async (c) =>
  (await c.query(`SELECT * FROM lead_manager.contract_match_pending WHERE lead_id=$1 ORDER BY created_at`, [id])).rows);
const run = (t, mode, leadIds, janelaDias) => withTenant(t, (c) => cc.runContractConvert(c, { tenantId: t, mode, leadIds, janelaDias }));
const setCfg = (t, mode, janela) => withTenant(t, (c) => c.query(
  `INSERT INTO lead_manager.tenant_lead_config (tenant_id, contract_convert_mode, contract_convert_janela_dias)
   VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET contract_convert_mode=$2, contract_convert_janela_dias=$3`,
  [t, mode, janela]));

const FUT = '2027-12-31';

before(async () => {});
after(async () => { await pool.end(); try { require('../src/redisClient').redis.disconnect(); } catch {} });

// ================= RÉGUA DE ORIGEM — o coração =================

// ---------- lead → contrato em 3 dias → CONVERSÃO ----------
test('O1 lead conversa e matricula 3 dias depois → convertido, desfecho_em = matrícula real', async () => {
  const phone = '5519991230001';
  await seedConversa(A, phone, '2026-06-10T14:00:00Z');
  await seedContract(A, { ini: '2026-06-13', fim: FUT, servico: 'Bateria', aluno: 'Filho Novo', pagador: 'Pai Novo', pagadorPhone: phone });
  const lead = await seedLead(A, { name: 'Pai Novo', phone, status: 'QUALIFYING' });
  const st = await run(A, 'auto', [lead]);
  assert.equal(st.convertido, 1); assert.equal(st.cliente, 0);
  const l = await leadOf(A, lead);
  assert.equal(l.status, 'CONVERTED'); assert.equal(l.desfecho, 'matriculado'); assert.equal(l.d, '2026-06-13');
});

// ---------- conversa em junho, matrícula com vigência em agosto (Denise/Carla/Ronaldo) ----------
test('O2 matrícula 51 dias DEPOIS da 1ª mensagem → convertido (a janela não é teto para a frente)', async () => {
  const phone = '5519994420370';
  await seedConversa(A, phone, '2026-06-16T09:00:00Z');
  await seedContract(A, { ini: '2026-08-06', fim: FUT, aluno: 'Denise Leal', alunoPhone: phone });
  const lead = await seedLead(A, { name: 'Denise Leal', phone });
  assert.equal((await run(A, 'auto', [lead])).convertido, 1);
  assert.equal((await leadOf(A, lead)).d, '2026-08-06');
});

// ---------- contrato ANOS antes da 1ª mensagem → CLIENTE, não conversão ----------
test('O3 contrato 2 anos antes da 1ª mensagem → cliente (fora da fila e da taxa)', async () => {
  const phone = '5519996951004';
  await seedConversa(A, phone, '2026-06-15T10:00:00Z');
  await seedContract(A, { ini: '2024-04-03', fim: FUT, aluno: 'Valentina', pagador: 'Vanessa Faria', pagadorPhone: phone });
  const lead = await seedLead(A, { name: 'Vanessa Faria', phone, status: 'NOT_LEAD' });
  const st = await run(A, 'auto', [lead]);
  assert.equal(st.cliente, 1); assert.equal(st.convertido, 0);
  const l = await leadOf(A, lead);
  assert.equal(l.status, 'NOT_LEAD'); assert.equal(l.desfecho, 'cliente'); assert.equal(l.d, '2024-04-03');
  assert.equal(stages.stageKey(l.status, l.desfecho), 'cliente', 'a régua canônica nomeia o estado');
  assert.equal((await logOf(A, lead))[0].to_stage, 'cliente', 'revertível no Monitor');
});

// ---------- VANESSA GARCIA: veterano que RENOVA depois de mandar mensagem → cliente ----------
test('O4 veterano de 2024 que RENOVA depois da 1ª mensagem → cliente (renovação ≠ matrícula nova)', async () => {
  const phone = '5511969060243';
  await seedConversa(A, phone, '2026-06-17T22:19:00Z');
  // 5 contratos de Guitarra desde 2024; o VIGENTE começa DEPOIS da 1ª mensagem (renovação).
  await seedContract(A, { ini: '2024-05-09', fim: '2024-08-09', servico: 'Guitarra', aluno: 'Mateus Garcia', pagador: 'Vanessa Garcia', pagadorPhone: phone });
  await seedContract(A, { ini: '2025-09-02', fim: '2026-03-02', servico: 'Guitarra', aluno: 'Mateus Garcia 2', pagador: 'Vanessa Garcia', pagadorPhone: phone });
  await seedContract(A, { ini: '2026-06-25', fim: FUT, servico: 'Guitarra', aluno: 'Mateus Garcia 3', pagador: 'Vanessa Garcia', pagadorPhone: phone });
  const lead = await seedLead(A, { name: 'Vanessa Garcia', phone, status: 'NOT_LEAD' });
  const st = await run(A, 'auto', [lead]);
  assert.equal(st.cliente, 1, 'a matrícula ORIGINAL (2024) manda, não a renovação de 2026');
  const l = await leadOf(A, lead);
  assert.equal(l.desfecho, 'cliente'); assert.equal(l.d, '2024-05-09');
});

// ---------- borda: dentro e fora da janela de 7 dias ----------
test('O5 borda da janela: contrato 5 dias ANTES da 1ª mensagem → convertido; 9 dias antes → cliente', async () => {
  const dentro = '5519991230005', fora = '5519991230006';
  await seedConversa(A, dentro, '2026-06-20T10:00:00Z');
  await seedContract(A, { ini: '2026-06-15', fim: FUT, aluno: 'Borda Dentro', alunoPhone: dentro });
  const lDentro = await seedLead(A, { name: 'Borda Dentro', phone: dentro });
  await seedConversa(A, fora, '2026-06-20T10:00:00Z');
  await seedContract(A, { ini: '2026-06-11', fim: FUT, aluno: 'Borda Fora', alunoPhone: fora });
  // fora do funil → o 'cliente' aplica sozinho (o lead VIVO vai para a fila; O13 cobre esse caso).
  const lFora = await seedLead(A, { name: 'Borda Fora', phone: fora, status: 'NOT_LEAD' });
  const st = await run(A, 'auto', [lDentro, lFora], 7);
  assert.equal(st.convertido, 1); assert.equal(st.cliente, 1);
  assert.equal((await leadOf(A, lDentro)).desfecho, 'matriculado', '5 dias antes cabe na tolerância');
  assert.equal((await leadOf(A, lFora)).desfecho, 'cliente', '9 dias antes não cabe');
});

test('O6 janela por-tenant: com janela=0 o mesmo caso de 5 dias antes vira cliente', async () => {
  const phone = '5519991230007';
  await seedConversa(A, phone, '2026-06-20T10:00:00Z');
  await seedContract(A, { ini: '2026-06-15', fim: FUT, aluno: 'Janela Zero', alunoPhone: phone });
  const lead = await seedLead(A, { name: 'Janela Zero', phone, status: 'NOT_LEAD' });
  assert.equal((await run(A, 'auto', [lead], 0)).cliente, 1);
  assert.equal((await leadOf(A, lead)).desfecho, 'cliente');
});

// ---------- marco = 1ª MENSAGEM, não created_at ----------
test('O7 marco é a 1ª MENSAGEM: created_at 13 dias depois (ingestão em lote) não muda a decisão', async () => {
  const phone = '5519991230008';
  await seedConversa(A, phone, '2026-06-12T08:00:00Z');
  await seedContract(A, { ini: '2026-06-18', fim: FUT, aluno: 'Caio Vilela', alunoPhone: phone });
  // created_at (25/06) é POSTERIOR à matrícula (18/06): por created_at seria "cliente"; pela 1ª mensagem é conversão.
  const lead = await seedLead(A, { name: 'Caio Vilela', phone, createdAt: '2026-06-25T12:00:00Z' });
  const index = await withTenant(A, (c) => cc.buildContractIndex(c, { tenantId: A }));
  const d = cc.decidir({ phone, created_at: new Date('2026-06-25T12:00:00Z') }, index, { janelaDias: 7 });
  assert.equal(d.marcoFonte, 'primeira_mensagem'); assert.equal(d.marco, '2026-06-12');
  assert.equal((await run(A, 'auto', [lead])).convertido, 1);
});

test('O8 sem conversa: cai no fallback created_at (marco honesto, sem inventar)', async () => {
  const phone = '5519991230009';
  await seedContract(A, { ini: '2026-07-01', fim: FUT, aluno: 'Sem Conversa', alunoPhone: phone });
  const lead = await seedLead(A, { name: 'Sem Conversa', phone, createdAt: '2026-06-28T12:00:00Z' });
  const index = await withTenant(A, (c) => cc.buildContractIndex(c, { tenantId: A }));
  const d = cc.decidir({ phone, created_at: new Date('2026-06-28T12:00:00Z') }, index, { janelaDias: 7 });
  assert.equal(d.marcoFonte, 'created_at'); assert.equal(d.decisao, 'convertido');
  assert.equal((await run(A, 'auto', [lead])).convertido, 1);
});

// ================= TAXA =================

// ---------- a taxa conta só quem nasceu no funil ----------
test('O9 TAXA: cliente sai do numerador E do denominador; só o nascido no funil conta', async () => {
  const pConv = '5519991230010', pCli = '5519991230011';
  await seedConversa(A, pConv, '2026-06-05T10:00:00Z');
  await seedContract(A, { ini: '2026-06-09', fim: FUT, aluno: 'Taxa Conv', alunoPhone: pConv });
  const lConv = await seedLead(A, { name: 'Taxa Conv', phone: pConv });
  await seedConversa(A, pCli, '2026-06-05T10:00:00Z');
  await seedContract(A, { ini: '2025-01-09', fim: FUT, aluno: 'Taxa Cli', alunoPhone: pCli });
  const lCli = await seedLead(A, { name: 'Taxa Cli', phone: pCli, status: 'NOT_LEAD' });
  await run(A, 'auto', [lConv, lCli]);
  // Universo do BI (mesmos predicados do computeFunil/computeKanban em metrics.js).
  const universo = await withTenant(A, async (c) => (await c.query(
    `SELECT count(*)::int AS leads,
            count(*) FILTER (WHERE desfecho='matriculado')::int AS matriculas
       FROM lead_manager.leads
      WHERE tenant_id=$1 AND id = ANY($2::uuid[])
        AND status NOT IN ('NOT_LEAD','REVIEW_QUEUE')
        AND coalesce(desfecho,'') <> 'cliente'`, [A, [lConv, lCli]])).rows[0]);
  assert.equal(universo.leads, 1, 'o cliente pré-existente não entra no denominador');
  assert.equal(universo.matriculas, 1, 'só a conversão real entra no numerador');
});

// ================= GUARDAS =================

test('O10 latch HUMANO (review_by = papel real) → não toca (nem convertido, nem cliente)', async () => {
  const phone = '5519991110020';
  await seedConversa(A, phone, '2026-06-01T10:00:00Z');
  await seedContract(A, { ini: '2024-05-01', fim: FUT, aluno: 'Filho V', pagador: 'Vanessa H', pagadorPhone: phone });
  const lead = await seedLead(A, { name: 'Vanessa H', phone, status: 'NOT_LEAD', reviewResult: 'confirmed_not_lead', reviewBy: 'RECEPCAO' });
  const st = await run(A, 'auto', [lead]);
  assert.equal(st.scanned, 0, 'latch humano nem entra');
  assert.equal((await leadOf(A, lead)).desfecho, null);
});

test('O11 NOT_LEAD auto (SERVICE) NÃO bloqueia: com origem no funil, converte', async () => {
  const phone = '5519991110021';
  await seedConversa(A, phone, '2026-06-01T10:00:00Z');
  await seedContract(A, { ini: '2026-06-04', fim: FUT, aluno: 'Filho S', pagador: 'Pai Service', pagadorPhone: phone });
  const lead = await seedLead(A, { name: 'Pai Service', phone, status: 'NOT_LEAD', reviewResult: 'confirmed_not_lead', reviewBy: 'SERVICE' });
  assert.equal((await run(A, 'auto', [lead])).convertido, 1);
  assert.equal((await logOf(A, lead))[0].prior_status, 'NOT_LEAD');
});

test('O12 matrícula registrada por HUMANO nunca é rebaixada a cliente', async () => {
  const phone = '5519991230012';
  await seedConversa(A, phone, '2026-06-20T10:00:00Z');
  await seedContract(A, { ini: '2024-02-01', fim: FUT, aluno: 'Filho MN', pagador: 'M Neto', pagadorPhone: phone });
  const lead = await seedLead(A, { name: 'M Neto', phone, status: 'QUALIFIED', desfecho: 'matriculado' });
  const st = await run(A, 'auto', [lead]);
  assert.equal(st.scanned, 0, 'matriculado no funil nem é elegível');
  const l = await leadOf(A, lead);
  assert.equal(l.desfecho, 'matriculado'); assert.equal(l.status, 'QUALIFIED');
});

test('O13 lead VIVO no funil não é marcado cliente sozinho — vai para a fila', async () => {
  const phone = '5519991230013';
  await seedConversa(A, phone, '2026-06-20T10:00:00Z');
  await seedContract(A, { ini: '2024-02-01', fim: FUT, aluno: 'Filho Vivo', pagador: 'Pai Vivo', pagadorPhone: phone });
  const lead = await seedLead(A, { name: 'Pai Vivo', phone, status: 'QUALIFIED' });
  const st = await run(A, 'auto', [lead]);
  assert.equal(st.cliente, 0); assert.equal(st.queued, 1);
  assert.equal((await leadOf(A, lead)).status, 'QUALIFIED', 'segue vivo na mesa');
  const p = (await pendOf(A, lead))[0];
  assert.equal(p.decisao, 'cliente'); assert.equal(p.reason, 'responsavel');
});

test('O14 sem vínculo vigente → não toca (ex-aluno com contrato expirado segue no funil)', async () => {
  const semNada = await seedLead(A, { name: 'Sem Vinculo', phone: '5519990000030' });
  const exPhone = '5519990000031';
  await seedConversa(A, exPhone, '2026-06-20T10:00:00Z');
  await seedContract(A, { ini: '2024-01-01', fim: '2024-12-31', aluno: 'Ex Aluno', alunoPhone: exPhone });
  const ex = await seedLead(A, { name: 'Ex Aluno', phone: exPhone });
  const st = await run(A, 'auto', [semNada, ex]);
  assert.equal(st.convertido, 0); assert.equal(st.cliente, 0); assert.equal(st.none, 2);
  assert.equal((await leadOf(A, ex)).status, 'QUALIFYING', 'reativação continua sendo lead');
});

test('O15 idempotência: quem já é cliente sai do universo elegível (renovação não re-enfileira)', async () => {
  const phone = '5519991230015';
  await seedConversa(A, phone, '2026-06-20T10:00:00Z');
  await seedContract(A, { ini: '2024-02-01', fim: FUT, aluno: 'Filho Idem', pagador: 'Pai Idem', pagadorPhone: phone });
  const lead = await seedLead(A, { name: 'Pai Idem', phone, status: 'NOT_LEAD' });
  assert.equal((await run(A, 'auto', [lead])).cliente, 1);
  // renovação chega: contrato NOVO para a mesma pessoa
  await seedContract(A, { ini: '2026-07-01', fim: FUT, aluno: 'Filho Idem 2', pagador: 'Pai Idem', pagadorPhone: phone });
  const st2 = await run(A, 'auto', [lead]);
  assert.equal(st2.scanned, 0, 'a marca no LEAD (desfecho=cliente) mata o re-enfileiramento');
  assert.equal((await logOf(A, lead)).length, 1);
});

// ================= FILA / MODOS / REVERTER =================

test('O16 suggestion: nada se move; a fila mostra as DUAS datas e a decisão', async () => {
  const phone = '5511900000031';
  await seedConversa(A, phone, '2026-06-06T10:00:00Z');
  await seedContract(A, { ini: '2026-06-09', fim: FUT, aluno: 'Filho Sug', pagador: 'Sug Pai', pagadorPhone: phone });
  const lead = await seedLead(A, { name: 'Sug Pai', phone });
  const st = await run(A, 'suggestion', [lead]);
  assert.equal(st.convertido, 0); assert.equal(st.queued, 1);
  assert.equal((await leadOf(A, lead)).status, 'QUALIFYING');
  const p = (await pendOf(A, lead))[0];
  assert.equal(p.decisao, 'convertido'); assert.equal(p.reason, 'responsavel');
  assert.equal(p.marco_lead.toISOString().slice(0, 10), '2026-06-06');
  assert.equal(p.matricula_primeira.toISOString().slice(0, 10), '2026-06-09');
});

test('O17 modo off → no-op (kill-switch)', async () => {
  const phone = '5511900000032';
  await seedConversa(A, phone, '2026-06-06T10:00:00Z');
  await seedContract(A, { ini: '2026-06-06', fim: FUT, aluno: 'Al Off', alunoPhone: phone });
  const lead = await seedLead(A, { name: 'Al Off', phone });
  const st = await run(A, 'off', [lead]);
  assert.equal(st.skipped, -1); assert.equal((await pendOf(A, lead)).length, 0);
});

test('O18 config por-tenant: sem mode explícito, runContractConvert lê tenant_lead_config', async () => {
  await setCfg(A, 'suggestion', 7);
  const phone = '5511900000033';
  await seedConversa(A, phone, '2026-06-06T10:00:00Z');
  await seedContract(A, { ini: '2026-06-08', fim: FUT, aluno: 'Cfg Aluno', alunoPhone: phone });
  const lead = await seedLead(A, { name: 'Cfg Aluno', phone });
  const st = await withTenant(A, (c) => cc.runContractConvert(c, { tenantId: A, leadIds: [lead] }));
  assert.equal(st.queued, 1, 'modo veio da config do tenant');
  await setCfg(A, 'off', 7);
  assert.equal((await withTenant(A, (c) => cc.runContractConvert(c, { tenantId: A, leadIds: [lead] }))).skipped, -1);
});

test('O19 confirmar na fila aplica a decisão (convertido com a data do contrato)', async () => {
  const phone = '5519911112020';
  await seedConversa(A, phone, '2026-05-18T10:00:00Z');
  await seedContract(A, { ini: '2026-05-20', fim: FUT, aluno: 'Al Fila', alunoPhone: phone });
  const lead = await seedLead(A, { name: 'Al Fila', phone });
  await run(A, 'suggestion', [lead]);
  const pend = (await pendOf(A, lead))[0];
  const out = await withTenant(A, (c) => cc.confirmPending(c, { tenantId: A, pendingId: pend.id, actor: 'recep' }));
  assert.equal(out.ok, true); assert.equal(out.decisao, 'convertido');
  assert.equal((await leadOf(A, lead)).d, '2026-05-20');
  assert.equal((await pendOf(A, lead))[0].status, 'confirmed');
});

test('O20 confirmar um "cliente" da fila marca cliente (não convertido)', async () => {
  const phone = '5519911112021';
  await seedConversa(A, phone, '2026-06-18T10:00:00Z');
  await seedContract(A, { ini: '2025-03-01', fim: FUT, aluno: 'Filho Cli', pagador: 'Pai Cli', pagadorPhone: phone });
  const lead = await seedLead(A, { name: 'Pai Cli', phone, status: 'QUALIFIED' });
  await run(A, 'suggestion', [lead]);
  const pend = (await pendOf(A, lead))[0];
  assert.equal(pend.decisao, 'cliente');
  const out = await withTenant(A, (c) => cc.confirmPending(c, { tenantId: A, pendingId: pend.id, actor: 'recep' }));
  assert.equal(out.ok, true); assert.equal(out.decisao, 'cliente');
  const l = await leadOf(A, lead);
  assert.equal(l.status, 'NOT_LEAD'); assert.equal(l.desfecho, 'cliente');
});

test('O21 reverter (Monitor 078) restaura o estado EXATO — nos dois destinos', async () => {
  const cenario = async (ini, statusInicial) => {
    const phone = `551995555${String(7000 + (SEQ % 900)).padStart(4, '0')}`;
    await seedConversa(A, phone, '2026-06-01T10:00:00Z');
    await seedContract(A, { ini, fim: FUT, aluno: `Al ${ini}`, pagador: `Pai ${ini}`, pagadorPhone: phone });
    const lead = await seedLead(A, { name: `Rev ${ini}`, phone, status: statusInicial });
    await run(A, 'auto', [lead]);
    const log = (await logOf(A, lead))[0];
    await withTenant(A, async (c) => {   // mesma sequência do endpoint /stage-autoapply/decisions/:id/reverter
      await c.query(`UPDATE lead_manager.leads SET status=$2, desfecho=$3, desfecho_em=$4,
                       suggested_stage=NULL, suggested_stage_dismissed=$5, updated_at=now() WHERE id=$1`,
        [lead, log.prior_status, log.prior_desfecho, log.prior_desfecho_em, log.to_stage]);
      await c.query(`DELETE FROM lead_manager.lead_eventos WHERE id=$1 AND lead_id=$2 AND tipo='mudanca_etapa'`, [log.evento_id, lead]);
      await c.query(`UPDATE lead_manager.stage_autoapply_log SET reverted=true WHERE id=$1`, [log.id]);
    });
    return { lead, log, l: await leadOf(A, lead) };
  };
  const conv = await cenario('2026-06-04', 'NOT_LEAD');       // → convertido
  assert.equal(conv.log.to_stage, 'convertido');
  assert.equal(conv.l.status, 'NOT_LEAD'); assert.equal(conv.l.desfecho, null); assert.equal(conv.l.d, null);
  const cli = await cenario('2024-01-04', 'NOT_LEAD');        // → cliente
  assert.equal(cli.log.to_stage, 'cliente');
  assert.equal(cli.l.status, 'NOT_LEAD'); assert.equal(cli.l.desfecho, null, 'volta a NÃO ter desfecho');
});

// ================= LISTA (read-only) e MULTI-TENANT =================

test('O22 buildBackfillList separa converte × clientes com as duas datas, sem mover nada', async () => {
  const pConv = '5519943000020', pCli = '5519943000021';
  await seedConversa(A, pConv, '2026-06-01T10:00:00Z');
  await seedContract(A, { ini: '2026-05-30', fim: FUT, aluno: 'BF Filho', pagador: 'BF Pai', pagadorPhone: pConv });
  const lConv = await seedLead(A, { name: 'BF Pai', phone: pConv });
  await seedConversa(A, pCli, '2026-06-01T10:00:00Z');
  await seedContract(A, { ini: '2024-06-01', fim: FUT, aluno: 'BF Velho', alunoPhone: pCli });
  const lCli = await seedLead(A, { name: 'BF Velho', phone: pCli, status: 'NOT_LEAD' });
  const list = await withTenant(A, (c) => cc.buildBackfillList(c, { tenantId: A, janelaDias: 7 }));
  const conv = list.converte.find((x) => x.lead_id === lConv);
  const cli = list.clientes.find((x) => x.lead_id === lCli);
  assert.ok(conv, 'nasceu no funil'); assert.equal(conv.papel, 'responsavel'); assert.equal(conv.aluno, 'BF Filho');
  assert.equal(conv.marco_lead, '2026-06-01'); assert.equal(conv.matricula_primeira, '2026-05-30'); assert.equal(conv.gap_dias, -2);
  assert.ok(cli, 'pré-existente'); assert.equal(cli.papel, 'aluno'); assert.equal(cli.gap_dias, -730);
  assert.equal((await leadOf(A, lConv)).status, 'QUALIFYING', 'lista não move');
  assert.equal((await leadOf(A, lCli)).desfecho, null, 'lista não move');
});

test('O23 multi-tenant: rodar em A não toca o lead idêntico de B', async () => {
  const phone = '5519990007777';
  const seedBoth = async (t) => {
    await seedConversa(t, phone, '2026-06-01T10:00:00Z');
    await seedContract(t, { ini: '2026-06-05', fim: FUT, aluno: 'X Filho', pagador: 'Cross Pai', pagadorPhone: phone });
    return seedLead(t, { name: 'Cross Pai', phone });
  };
  const la = await seedBoth(A); const lb = await seedBoth(B);
  await run(A, 'auto', null);
  assert.equal((await leadOf(A, la)).status, 'CONVERTED');
  assert.equal((await leadOf(B, lb)).status, 'QUALIFYING', 'B intacto');
});
