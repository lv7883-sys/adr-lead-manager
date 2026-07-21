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

// Pré-carga do cadastro (backfill): Ana (menor dependente, sem fone próprio) + Bruno (adulto self_paid).
const LOTE_PRELOAD = { itens: [
  { beneficiario: { idExterno: 'A1', nome: 'Ana Aluna', dataNascimento: '2013-05-10', payerRelation: 'financially_dependent' },
    responsavelFinanceiro: { idExterno: 'R1', nome: 'Pai da Ana', telefone: '19 99999-0002' } },
  { beneficiario: { idExterno: 'A2', nome: 'Bruno Aluno', telefone: '19999990003', payerRelation: 'self_paid' } },
] };
// Contratos (CONTRACT-ONLY: aluno/responsavel = SÓ idExterno; nada de nome/telefone).
const LOTE = { itens: [
  { aluno: { idExterno: 'A1' }, responsavel: { idExterno: 'R1' },
    contrato: { idExterno: 'C1', instrumento: 'Violão', status: 'Ativo', periodicidade: 'anual', planoLabel: 'Anual à vista', ini: '2026-01-01', fim: '2026-12-31' } },
  { aluno: { idExterno: 'A2' },
    contrato: { idExterno: 'C2', instrumento: 'Bateria', status: 'Ativo', periodicidade: 'trimestral', planoLabel: 'Flex Trimestral', ini: '2026-01-01', fim: '2026-04-01' } },
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

test('(a) contratos CONTRACT-ONLY: casa por id, titular por dependência financeira, plano_label/periodicidade, sem tocar pessoa', async () => {
  // pré-carga do cadastro (backfill) — cria pessoas + papel + payer_relation
  const pre = await postBen(TENANT_A, LOTE_PRELOAD);
  assert.equal(pre.status, 200);
  // o backfill escreveu o PAPEL que o Gate 0 lê (ADR-036 E1.3a) — Bruno self_paid tem fone próprio.
  const lk = await q(TENANT_A, `SELECT cr.key, cr.suppression FROM lead_manager.contact_role_member m
    JOIN lead_manager.contact_role cr ON cr.id=m.role_id
   WHERE regexp_replace(m.phone,'[^0-9]','','g')=regexp_replace($1,'[^0-9]','','g') LIMIT 1`, ['19999990003']);
  assert.equal(lk[0]?.key, 'beneficiario', 'Gate 0 resolve o papel canônico do beneficiário');
  assert.equal(lk[0]?.suppression, 'hard');
  const cpAntes = Number((await q(TENANT_A, `SELECT count(*) n FROM lead_manager.contact_point WHERE kind='phone'`))[0].n);
  const roleAntes = Number((await q(TENANT_A, `SELECT count(*) n FROM lead_manager.contact_role_member`))[0].n);

  // ingestão de contrato (contract-only)
  const r = await post(TENANT_A, LOTE);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.resumo, { itens: 2, pessoas_novas: 0, contratos_novos: 2, vinculos_novos: 4, pulados: 0 });

  // TITULAR por dependência financeira: C1 (Ana dependente) → benef=Ana + pagador=Pai;
  //                                     C2 (Bruno self_paid) → benef + pagador = o próprio Bruno.
  const c1 = await q(TENANT_A, `SELECT am.bond, p.display_name FROM lead_manager.external_ref er
    JOIN lead_manager.account_member am ON am.account_id=er.entity_id JOIN lead_manager.person p ON p.id=am.person_id
   WHERE er.external_type='contrato' AND er.external_id='C1' ORDER BY am.bond`);
  assert.deepEqual(c1, [{ bond: 'beneficiario', display_name: 'Ana Aluna' }, { bond: 'pagador', display_name: 'Pai da Ana' }]);
  const c2 = await q(TENANT_A, `SELECT am.bond, p.display_name FROM lead_manager.external_ref er
    JOIN lead_manager.account_member am ON am.account_id=er.entity_id JOIN lead_manager.person p ON p.id=am.person_id
   WHERE er.external_type='contrato' AND er.external_id='C2' ORDER BY am.bond`);
  assert.deepEqual(c2, [{ bond: 'beneficiario', display_name: 'Bruno Aluno' }, { bond: 'pagador', display_name: 'Bruno Aluno' }]);

  // periodicidade + plano_label gravados no contrato
  const sa = await q(TENANT_A, `SELECT servico_label, periodicidade, plano_label FROM lead_manager.service_account ORDER BY servico_label`);
  assert.deepEqual(sa, [
    { servico_label: 'Bateria', periodicidade: 'trimestral', plano_label: 'Flex Trimestral' },
    { servico_label: 'Violão', periodicidade: 'anual', plano_label: 'Anual à vista' },
  ]);

  // CONTRACT-ONLY: não tocou pessoa — contact_point e papéis inalterados desde a pré-carga.
  const cpDepois = Number((await q(TENANT_A, `SELECT count(*) n FROM lead_manager.contact_point WHERE kind='phone'`))[0].n);
  const roleDepois = Number((await q(TENANT_A, `SELECT count(*) n FROM lead_manager.contact_role_member`))[0].n);
  assert.equal(cpDepois, cpAntes, 'contrato não adiciona/re-escreve contact_point');
  assert.equal(roleDepois, roleAntes, 'contrato não escreve papel (é do backfill)');
});

test('(b) re-ingerir contratos é idempotente (tudo novo = 0)', async () => {
  const r = await post(TENANT_A, LOTE);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.resumo, { itens: 2, pessoas_novas: 0, contratos_novos: 0, vinculos_novos: 0, pulados: 0 });
  const nAm = Number((await q(TENANT_A, `SELECT count(*) n FROM lead_manager.account_member`))[0].n);
  assert.equal(nAm, 4, 'sem duplicar vínculos (2 contratos × benef+pagador)');
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
  // Bruno (do teste a, self_paid) tem papel=beneficiario com telefone '19999990003'. Um beneficiário
  // novo com ESSE telefone deve casar o Bruno (bridar external_ref), NÃO criar pessoa nova.
  const nAntes = Number((await q(TENANT_A, `SELECT count(*) n FROM lead_manager.person`))[0].n);
  const r = await postBen(TENANT_A, { itens: [
    { beneficiario: { idExterno: 'BENX', nome: 'Bruno Aluno', telefone: '19999990003', payerRelation: 'self_paid' } },
  ] });
  assert.equal(r.json.resumo.beneficiarios_bridados, 1, 'casou (bridou) o beneficiário existente');
  assert.equal(r.json.resumo.beneficiarios_novos, 0, 'NÃO criou pessoa nova (sem duplicata)');
  const nDepois = Number((await q(TENANT_A, `SELECT count(*) n FROM lead_manager.person`))[0].n);
  assert.equal(nDepois, nAntes, 'total de pessoas inalterado — zero duplicata');
  const p = await q(TENANT_A, `SELECT p.display_name FROM lead_manager.external_ref er
    JOIN lead_manager.person p ON p.id=er.entity_id WHERE er.external_type='beneficiario' AND er.external_id='BENX'`);
  assert.equal(p[0].display_name, 'Bruno Aluno', 'external_ref BENX bridado na pessoa do Bruno');
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
