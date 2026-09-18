'use strict';
//
// sync-experimentais.itest.js — sync das aulas experimentais (migr 129). PG DESCARTÁVEL.
// Aplica as migrações REAIS 085 (br_phone_key) e 129 (aula_experimental) — então este teste também
// prova que a migração nova roda.
//
// O que mais importa aqui é a LIGAÇÃO aula → lead: um erro nela conta a aula de uma pessoa no funil de
// outra, e nenhum número da tela acusaria isso.
//
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const sync = require('../src/cadastro/sync-experimentais');

const T = '00000000-0000-0000-0000-0000000000e1';
const OUTRO = '00000000-0000-0000-0000-0000000000e2';
let c;
const mig = (n) => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', n), 'utf8');

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query(`
    DO $$ BEGIN CREATE ROLE lead_manager_user; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE SCHEMA IF NOT EXISTS lead_manager;
    CREATE TABLE lead_manager.leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid,
      name text, phone text, created_at timestamptz DEFAULT now());`);
  await c.query(mig('085_br_phone_key.sql'));
  await c.query(mig('129_aula_experimental.sql'));
});
after(async () => { await c.end(); });

const lead = async (tenant, phone, criado) => (await c.query(
  `INSERT INTO lead_manager.leads (tenant_id, name, phone, created_at) VALUES ($1,'x',$2,$3) RETURNING id`,
  [tenant, phone, criado || new Date()])).rows[0].id;
const aulaRow = async (id) => (await c.query(
  'SELECT * FROM lead_manager.aula_experimental WHERE tenant_id=$1 AND aula_id=$2', [T, id])).rows[0];

test('(1) registrar é idempotente: re-rodar a mesma grade não toca nada', async () => {
  const aulas = [{ aulaId: '1001', rotulo: 'Realizada', competencia: '2026-08' }];
  assert.equal(await sync.registrarAulas(c, T, aulas), 1);
  assert.equal(await sync.registrarAulas(c, T, aulas), 0, 'mesmo rótulo, mesma competência: no-op');
});

test('(2) detalhe é lido uma vez, e RELIDO quando o rótulo da grade muda', async () => {
  await sync.registrarAulas(c, T, [{ aulaId: '1002', rotulo: 'Realizada', competencia: '2026-08' }]);
  assert.deepEqual(await sync.idsParaDetalhar(c, T, ['1002']), ['1002'], 'nova: precisa de detalhe');
  await sync.aplicarDetalhes(c, T, [{ aulaId: '1002', statusCod: 200, statusRotulo: 'Realizada', fone1: '(19)99999-0002' }]);
  assert.deepEqual(await sync.idsParaDetalhar(c, T, ['1002']), [], 'detalhada e sem mudança: não relê');
  // semanas depois a pessoa matricula e a Extranet muda o rótulo da aula
  await sync.registrarAulas(c, T, [{ aulaId: '1002', rotulo: 'Realizada com matrícula posterior', competencia: '2026-08' }]);
  assert.deepEqual(await sync.idsParaDetalhar(c, T, ['1002']), ['1002'], 'rótulo mudou: relê o detalhe');
  await sync.aplicarDetalhes(c, T, [{ aulaId: '1002', statusCod: 220, statusRotulo: 'Realizada com matrícula posterior', fone1: '(19)99999-0002' }]);
  assert.equal((await aulaRow('1002')).status_cod, 220);
  assert.deepEqual(await sync.idsParaDetalhar(c, T, ['1002']), []);
});

test('(3) liga pelo telefone mesmo com formatos diferentes (Extranet x WhatsApp)', async () => {
  const l = await lead(T, '+5519999990003');                         // como o WhatsApp grava
  await sync.registrarAulas(c, T, [{ aulaId: '1003', rotulo: 'Realizada', competencia: '2026-08' }]);
  await sync.aplicarDetalhes(c, T, [{ aulaId: '1003', statusCod: 200, fone1: '(19)99999-0003' }]);   // como a Extranet mostra
  assert.ok(await sync.ligarLeads(c, T) >= 1);
  assert.equal((await aulaRow('1003')).lead_id, l);
});

test('(4) telefone VAZIO não casa com ninguém', async () => {
  // br_phone_key devolve '' para vazio. Sem a guarda, a aula sem telefone casaria com todo lead sem
  // telefone — e contaria aula para gente que nunca marcou.
  await lead(T, null); await lead(T, '');
  await sync.registrarAulas(c, T, [{ aulaId: '1004', rotulo: 'Realizada', competencia: '2026-08' }]);
  await sync.aplicarDetalhes(c, T, [{ aulaId: '1004', statusCod: 200, fone1: null, fone2: null }]);
  await sync.ligarLeads(c, T);
  assert.equal((await aulaRow('1004')).lead_id, null);
});

test('(5) mesmo telefone em dois leads: a aula vai para o MAIS ANTIGO (first-touch)', async () => {
  const antigo = await lead(T, '5519999990005', new Date('2026-06-01'));
  await lead(T, '(19)99999-0005', new Date('2026-08-01'));
  await sync.registrarAulas(c, T, [{ aulaId: '1005', rotulo: 'Realizada', competencia: '2026-08' }]);
  await sync.aplicarDetalhes(c, T, [{ aulaId: '1005', statusCod: 200, fone1: '(19)99999-0005' }]);
  await sync.ligarLeads(c, T);
  assert.equal((await aulaRow('1005')).lead_id, antigo);
});

test('(6) Telefone 2 também liga (quem cadastra às vezes põe o do responsável no 1)', async () => {
  const l = await lead(T, '5519999990006');
  await sync.registrarAulas(c, T, [{ aulaId: '1006', rotulo: 'Realizada', competencia: '2026-08' }]);
  await sync.aplicarDetalhes(c, T, [{ aulaId: '1006', statusCod: 200, fone1: '(19)98888-7777', fone2: '(19)99999-0006' }]);
  await sync.ligarLeads(c, T);
  assert.equal((await aulaRow('1006')).lead_id, l);
});

test('(7) nunca liga a lead de OUTRO tenant, mesmo com o mesmo telefone', async () => {
  await lead(OUTRO, '5519999990007');
  await sync.registrarAulas(c, T, [{ aulaId: '1007', rotulo: 'Realizada', competencia: '2026-08' }]);
  await sync.aplicarDetalhes(c, T, [{ aulaId: '1007', statusCod: 200, fone1: '(19)99999-0007' }]);
  await sync.ligarLeads(c, T);
  assert.equal((await aulaRow('1007')).lead_id, null, 'o lead com esse telefone é de outra unidade');
});

test('(8) ligação feita não é refeita (o número de um mês fechado não muda depois)', async () => {
  const primeiro = (await aulaRow('1003')).lead_id;
  await lead(T, '5519999990003', new Date('2020-01-01'));            // aparece um lead "mais antigo" depois
  await sync.ligarLeads(c, T);
  assert.equal((await aulaRow('1003')).lead_id, primeiro, 'a aula continua no lead original');
});

test('(9) resumo conta o espelho — valores EXATOS dos casos acima', async () => {
  // A primeira versão pedia "pelo menos 4 ligadas" e falhou: o certo são 3. 1003, 1005 e 1006 têm
  // lead; 1002 tem telefone sem lead, 1004 não tem telefone, 1007 é de outra unidade — exatamente
  // o que (4) e (7) garantem. Valor exato pega regressão que um "pelo menos" deixaria passar.
  const r = await sync.resumo(c, T);
  assert.equal(r.aulas, 7, 'aulas 1001..1007');
  assert.equal(r.detalhadas, 6, '1001 nunca foi detalhada');
  assert.equal(r.ligadas, 3, '1003, 1005, 1006');
  assert.equal(r.sem_lead, 3, '1002 (sem lead), 1004 (sem telefone), 1007 (outra unidade)');
  assert.equal(r.realizadas, 6, 'código de realizada: 1002 (220) + 1003..1007 (200) → ' + JSON.stringify(r));
});
