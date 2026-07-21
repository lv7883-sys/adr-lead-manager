'use strict';

// Testes de INTEGRAÇÃO do endpoint POST /tenant/:tid/cadastro/contratos (ADR-037 fatia 037.2).
// Ingestão aditiva/idempotente do cadastro-mestre a partir de um lote sintético (SEM scraper).
// Prova: (a) popula os 4 alvos + external_ref + data_nascimento + o ELO aluno↔responsável;
// (b) re-ingerir o mesmo lote = mesmas contagens (idempotente, cobre renovação);
// (c) cross-tenant = 0; (d) WITH CHECK bloqueia insert cross-tenant. PG descartável (051+060+061).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool, withTenant } = require('../src/db');

const TENANT_A = process.env.RESOURCES_TENANT_A;
const TENANT_B = process.env.RESOURCES_TENANT_B;
const TOKEN = jwt.sign({ role: 'service', service: 'itest' }, process.env.JWT_SECRET);

let server; let base;

function post(tid, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${base}/tenant/${tid}/cadastro/contratos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || '{}') })); });
    req.on('error', reject); req.write(data); req.end();
  });
}
const q = (tid, sql, params = []) => withTenant(tid, (c) => c.query(sql, params)).then((r) => r.rows);

// Lote sintético: Ana (menor, com responsável) + Bruno (sem responsável).
const LOTE = { itens: [
  { aluno: { idExterno: 'A1', nome: 'Ana Aluna', telefone: '(19) 99999-0001', dataNascimento: '2013-05-10' },
    responsavel: { idExterno: 'R1', nome: 'Pai da Ana', telefone: '19 99999-0002' },
    contrato: { idExterno: 'C1', instrumento: 'Violão', status: 'Ativo', ini: '2026-01-01', fim: '2026-12-31' } },
  { aluno: { idExterno: 'A2', nome: 'Bruno Aluno', telefone: '19999990003' },
    contrato: { idExterno: 'C2', instrumento: 'Bateria', status: 'Ativo' } },
] };

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/tenant', require('../src/routes/tenant'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

test('(a) ingestão popula os 4 alvos + external_ref + nascimento + o elo', async () => {
  const r = await post(TENANT_A, LOTE);
  assert.equal(r.status, 200);
  // papeis_novos = 3: aluno(Ana) + responsavel(Pai) + aluno(Bruno) — cada telefone ganha 1 papel.
  assert.deepEqual(r.json.resumo, { itens: 2, pessoas_novas: 3, contratos_novos: 2, telefones_novos: 3, vinculos_novos: 3, papeis_novos: 3, pulados: 0 });

  const [{ n: nPerson }] = await q(TENANT_A, `SELECT count(*) n FROM lead_manager.person`);
  const [{ n: nCp }] = await q(TENANT_A, `SELECT count(*) n FROM lead_manager.contact_point WHERE kind='phone'`);
  const [{ n: nSa }] = await q(TENANT_A, `SELECT count(*) n FROM lead_manager.service_account`);
  const [{ n: nAm }] = await q(TENANT_A, `SELECT count(*) n FROM lead_manager.account_member`);
  const [{ n: nRef }] = await q(TENANT_A, `SELECT count(*) n FROM lead_manager.external_ref`);
  assert.equal(Number(nPerson), 3, '3 pessoas (Ana, Pai, Bruno)');
  assert.equal(Number(nCp), 3, '3 telefones');
  assert.equal(Number(nSa), 2, '2 contratos');
  assert.equal(Number(nAm), 3, '2 beneficiário + 1 pagador');
  assert.equal(Number(nRef), 5, '3 person + 2 account');

  // instrumento + status no contrato
  const sa = await q(TENANT_A, `SELECT status, servico_label FROM lead_manager.service_account ORDER BY servico_label`);
  assert.deepEqual(sa.map((x) => x.servico_label), ['Bateria', 'Violão']);
  assert.ok(sa.every((x) => x.status === 'Ativo'));

  // nascimento da Ana
  const ana = await q(TENANT_A, `SELECT to_char(data_nascimento,'YYYY-MM-DD') d FROM lead_manager.person WHERE display_name='Ana Aluna'`);
  assert.equal(ana[0].d, '2013-05-10');

  // O ELO: no contrato C1, aluno=beneficiario (Ana) e responsável=pagador (Pai da Ana)
  const elo = await q(TENANT_A, `
    SELECT am.bond, p.display_name
      FROM lead_manager.external_ref er
      JOIN lead_manager.account_member am ON am.account_id = er.entity_id
      JOIN lead_manager.person p ON p.id = am.person_id
     WHERE er.entity_kind='account' AND er.external_type='contrato' AND er.external_id='C1'
     ORDER BY am.bond`);
  assert.deepEqual(elo, [
    { bond: 'beneficiario', display_name: 'Ana Aluna' },
    { bond: 'pagador', display_name: 'Pai da Ana' },
  ]);

  // ADR-036 E1.3a — o PAPEL (contact_role_member) que o Gate 0 lê foi escrito:
  //  3 papéis (Ana=aluno, Pai=responsavel, Bruno=aluno), cada um ligado à pessoa certa.
  const [{ n: nRole }] = await q(TENANT_A, `SELECT count(*) n FROM lead_manager.contact_role_member`);
  assert.equal(Number(nRole), 3, '3 papéis (2 aluno + 1 responsavel)');
  const papeis = await q(TENANT_A, `
    SELECT p.display_name, cr.key AS papel
      FROM lead_manager.contact_role_member m
      JOIN lead_manager.contact_role cr ON cr.id = m.role_id
      JOIN lead_manager.person p ON p.id = m.person_id
     ORDER BY p.display_name`);
  assert.deepEqual(papeis, [
    { display_name: 'Ana Aluna', papel: 'beneficiario' },
    { display_name: 'Bruno Aluno', papel: 'beneficiario' },
    { display_name: 'Pai da Ana', papel: 'responsavel_financeiro' },
  ]);

  // (6) _lookupRole (Gate 0) AGORA resolve o papel por dígitos BR-aware — mesmo com o gate
  // em shadow/off, o papel tem que estar lá. Reproduz o match de engine._lookupRole.
  const lk = await q(TENANT_A, `
    SELECT cr.key, cr.suppression
      FROM lead_manager.contact_role_member m
      JOIN lead_manager.contact_role cr ON cr.id = m.role_id
     WHERE regexp_replace(m.phone,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')
     LIMIT 1`, ['(19) 99999-0001']);  // telefone da Ana
  assert.equal(lk[0]?.key, 'beneficiario', 'Gate 0 acharia Ana como beneficiário (papel canônico resolvido)');
  assert.equal(lk[0]?.suppression, 'hard', 'papel beneficiario = suppression hard');
});

test('(b) re-ingerir o mesmo lote é idempotente (tudo novo = 0, contagens iguais)', async () => {
  const r = await post(TENANT_A, LOTE);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.resumo, { itens: 2, pessoas_novas: 0, contratos_novos: 0, telefones_novos: 0, vinculos_novos: 0, papeis_novos: 0, pulados: 0 });
  const [{ n: nPerson }] = await q(TENANT_A, `SELECT count(*) n FROM lead_manager.person`);
  const [{ n: nAm }] = await q(TENANT_A, `SELECT count(*) n FROM lead_manager.account_member`);
  const [{ n: nRole }] = await q(TENANT_A, `SELECT count(*) n FROM lead_manager.contact_role_member`);
  assert.equal(Number(nPerson), 3, 'sem duplicar pessoas');
  assert.equal(Number(nAm), 3, 'sem duplicar vínculos');
  assert.equal(Number(nRole), 3, 'sem duplicar papéis (idempotente por dígitos)');
});

test('(c) CROSS-TENANT = 0: o que A ingeriu é invisível a B', async () => {
  const [{ n }] = await q(TENANT_B, `SELECT count(*) n FROM lead_manager.person`);
  assert.equal(Number(n), 0, 'B não vê pessoas de A');
  // B ingere o seu próprio lote e continua isolado
  await post(TENANT_B, { itens: [{ aluno: { idExterno: 'B1', nome: 'Só de B' }, contrato: { idExterno: 'CB', instrumento: 'Canto', status: 'Ativo' } }] });
  const bs = await q(TENANT_B, `SELECT display_name FROM lead_manager.person`);
  assert.deepEqual(bs.map((x) => x.display_name), ['Só de B']);
  const as = await q(TENANT_A, `SELECT count(*) n FROM lead_manager.person`);
  assert.equal(Number(as[0].n), 3, 'A intacto, sem vazamento de B');
});

test('(d) WITH CHECK bloqueia insert cross-tenant', async () => {
  let bloqueado = false;
  try {
    await withTenant(TENANT_B, (c) => c.query(
      `INSERT INTO lead_manager.person (tenant_id, display_name) VALUES ($1,'Forjado')`, [TENANT_A]));
  } catch (e) { bloqueado = /row-level security|violates/i.test(e.message); }
  assert.ok(bloqueado, 'policy WITH CHECK deve barrar tenant_id alheio');
});

// ---- BACKFILL: endpoint abstrato /cadastro/beneficiarios ----
function postBen(tid, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${base}/tenant/${tid}/cadastro/beneficiarios`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || '{}') })); });
    req.on('error', reject); req.write(data); req.end();
  });
}
const LOTE_BEN = { itens: [
  { beneficiario: { idExterno: 'BEN1', nome: 'Carlos Self', telefone: '19 98888-1111', payerRelation: 'self_paid' } },
  { beneficiario: { idExterno: 'BEN2', nome: 'Duda Dependente', dataNascimento: '2015-03-03', payerRelation: 'financially_dependent' },
    responsavelFinanceiro: { idExterno: 'RESP1', nome: 'Mae da Duda', telefone: '19 98888-2222' } },
] };

test('(e) /cadastro/beneficiarios: cria beneficiário + responsável, external_ref, tipo=cadastro, payer_relation, SEM account_member', async () => {
  const amAntes = Number((await q(TENANT_A, `SELECT count(*) n FROM lead_manager.account_member`))[0].n);
  const r = await postBen(TENANT_A, LOTE_BEN);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.resumo, { itens: 2, beneficiarios_novos: 2, beneficiarios_bridados: 0, responsaveis_novos: 1,
    responsaveis_bridados: 0, telefones_novos: 2, papeis_novos: 2, ambiguos: 0, pulados: 0 });

  // external_ref canônico
  const refs = await q(TENANT_A, `SELECT external_type, external_id FROM lead_manager.external_ref
     WHERE external_id IN ('BEN1','BEN2','RESP1') ORDER BY external_id`);
  assert.deepEqual(refs, [
    { external_type: 'beneficiario', external_id: 'BEN1' },
    { external_type: 'beneficiario', external_id: 'BEN2' },
    { external_type: 'responsavel_financeiro', external_id: 'RESP1' },
  ]);
  // payer_relation gravado
  const pr = await q(TENANT_A, `SELECT display_name, payer_relation FROM lead_manager.person WHERE display_name IN ('Carlos Self','Duda Dependente') ORDER BY display_name`);
  assert.deepEqual(pr, [
    { display_name: 'Carlos Self', payer_relation: 'self_paid' },
    { display_name: 'Duda Dependente', payer_relation: 'financially_dependent' },
  ]);
  // telefone tipo='cadastro' (BEN1 + RESP1; BEN2 sem telefone)
  const cps = await q(TENANT_A, `SELECT DISTINCT tipo, source, confidence FROM lead_manager.contact_point
     WHERE value_raw LIKE '%98888%'`);
  assert.deepEqual(cps, [{ tipo: 'cadastro', source: 'extranet', confidence: 'alegado' }]);
  // SEM account_member novo (vínculo formal nasce com o contrato)
  const amDepois = Number((await q(TENANT_A, `SELECT count(*) n FROM lead_manager.account_member`))[0].n);
  assert.equal(amDepois, amAntes, 'backfill NÃO cria account_member');

  // idempotente: re-ingerir → tudo novo = 0
  const r2 = await postBen(TENANT_A, LOTE_BEN);
  assert.deepEqual(r2.json.resumo, { itens: 2, beneficiarios_novos: 0, beneficiarios_bridados: 0, responsaveis_novos: 0,
    responsaveis_bridados: 0, telefones_novos: 0, papeis_novos: 0, ambiguos: 0, pulados: 0 });
});

test('(h) ROLE-AWARE: beneficiário cujo telefone casa um beneficiário existente é BRIDADO, não duplicado', async () => {
  // Ana (do teste a) tem papel=beneficiario com telefone '(19) 99999-0001'. Um beneficiário novo
  // com ESSE telefone deve casar a Ana (bridar external_ref), NÃO criar pessoa nova.
  const nAntes = Number((await q(TENANT_A, `SELECT count(*) n FROM lead_manager.person`))[0].n);
  const r = await postBen(TENANT_A, { itens: [
    { beneficiario: { idExterno: 'BENX', nome: 'Ana Aluna', telefone: '(19) 99999-0001', payerRelation: 'self_paid' } },
  ] });
  assert.equal(r.json.resumo.beneficiarios_bridados, 1, 'casou (bridou) o beneficiário existente');
  assert.equal(r.json.resumo.beneficiarios_novos, 0, 'NÃO criou pessoa nova (sem duplicata)');
  const nDepois = Number((await q(TENANT_A, `SELECT count(*) n FROM lead_manager.person`))[0].n);
  assert.equal(nDepois, nAntes, 'total de pessoas inalterado — zero duplicata');
  // e o external_ref BENX aponta pra pessoa da Ana
  const p = await q(TENANT_A, `SELECT p.display_name FROM lead_manager.external_ref er
    JOIN lead_manager.person p ON p.id=er.entity_id WHERE er.external_type='beneficiario' AND er.external_id='BENX'`);
  assert.equal(p[0].display_name, 'Ana Aluna', 'external_ref BENX bridado na pessoa da Ana');
});

test('(f) telefone de cadastro COEXISTE com whatsapp preexistente (tipo)', async () => {
  const pid = (await q(TENANT_A, `SELECT p.id FROM lead_manager.person p
    JOIN lead_manager.external_ref er ON er.entity_id=p.id
   WHERE er.external_type='beneficiario' AND er.external_id='BEN1'`))[0].id;
  // simula o scheduler: um whatsapp (provado, tipo=whatsapp) com os MESMOS dígitos
  await q(TENANT_A, `INSERT INTO lead_manager.contact_point (tenant_id, person_id, kind, value_raw, source, confidence, tipo)
    VALUES ($1,$2,'phone','19988881111','whatsapp','provado','whatsapp')`, [TENANT_A, pid]);
  // re-ingere BEN1 → o de cadastro segue lá (não sobrescreve), 2 linhas
  await postBen(TENANT_A, { itens: [LOTE_BEN.itens[0]] });
  const cps = await q(TENANT_A, `SELECT tipo FROM lead_manager.contact_point WHERE person_id=$1 AND kind='phone' ORDER BY tipo`, [pid]);
  assert.deepEqual(cps.map((x) => x.tipo), ['cadastro', 'whatsapp'], 'cadastro e whatsapp coexistem');
});

test('(g) SEED de papéis por-tenant funciona p/ um tenant FICTÍCIO novo (multi-tenant real)', async () => {
  const C = process.env.RESOURCES_TENANT_C;
  const antes = await q(C, `SELECT count(*) n FROM lead_manager.contact_role`);
  assert.equal(Number(antes[0].n), 0, 'C começa sem papéis');
  await q(C, `SELECT lead_manager.seed_base_roles($1)`, [C]);   // provisionamento em runtime
  const papeis = await q(C, `SELECT key FROM lead_manager.contact_role ORDER BY key`);
  assert.deepEqual(papeis.map((x) => x.key), ['beneficiario', 'prestador', 'responsavel_financeiro'],
    'C recebe os 3 papéis canônicos sem código específico');
  // idempotente
  await q(C, `SELECT lead_manager.seed_base_roles($1)`, [C]);
  const n2 = await q(C, `SELECT count(*) n FROM lead_manager.contact_role`);
  assert.equal(Number(n2[0].n), 3, 'seed idempotente (não duplica)');
});
