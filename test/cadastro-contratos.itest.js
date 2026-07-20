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
    { display_name: 'Ana Aluna', papel: 'aluno' },
    { display_name: 'Bruno Aluno', papel: 'aluno' },
    { display_name: 'Pai da Ana', papel: 'responsavel' },
  ]);

  // (6) _lookupRole (Gate 0) AGORA resolve o papel por dígitos BR-aware — mesmo com o gate
  // em shadow/off, o papel tem que estar lá. Reproduz o match de engine._lookupRole.
  const lk = await q(TENANT_A, `
    SELECT cr.key, cr.suppression
      FROM lead_manager.contact_role_member m
      JOIN lead_manager.contact_role cr ON cr.id = m.role_id
     WHERE regexp_replace(m.phone,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')
     LIMIT 1`, ['(19) 99999-0001']);  // telefone da Ana
  assert.equal(lk[0]?.key, 'aluno', 'Gate 0 acharia Ana como aluno (papel resolvido)');
  assert.equal(lk[0]?.suppression, 'hard', 'papel aluno = suppression hard');
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
