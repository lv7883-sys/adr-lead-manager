'use strict';
// indicadores-fatiaE.itest.js — Fatia E: taxa de envio-sem-erro (#1) + funil "agendada"
// via EXPERIMENTAL_AGENDADA (#2). Testa as EXPRESSÕES SQL reais. PG descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

let c;
// #1 — mirror do r3 novo (franquia.js): só 'erro' no denominador (exclui pulado/ambiguo).
const TAXA_NOVA = `SELECT count(*) FILTER (WHERE status='enviado')::int env,
                          count(*) FILTER (WHERE status='erro')::int erro
                     FROM envio_log WHERE franquia_id=$1`;
const TAXA_ANTIGA = `SELECT count(*) FILTER (WHERE status='enviado')::int env,
                            count(*) FILTER (WHERE status IN ('erro','pulado'))::int falhou
                       FROM envio_log WHERE franquia_id=$1`;
// #2 — mirror do FILTER de "agendada" (metrics.js computeFunil), novo (EXPERIMENTAL_AGENDADA).
const AGENDADAS = `SELECT count(*) FILTER (
    WHERE intent='SCHEDULE_INTEREST' OR status='EXPERIMENTAL_AGENDADA' OR desfecho='nao_compareceu_aula'
  )::int n FROM leads WHERE status NOT IN ('NOT_LEAD','REVIEW_QUEUE')`;

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query(`
    CREATE TABLE envio_log (id serial PRIMARY KEY, franquia_id int, status text);
    CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, intent text, desfecho text);`);
  // números reais da auditoria: enviado 273, erro 14, pulado(opt-out) 101, ambiguo(no_match) 75
  const seed = (st, n) => c.query(`INSERT INTO envio_log (franquia_id, status) SELECT 1, $1 FROM generate_series(1,$2)`, [st, n]);
  await seed('enviado', 273); await seed('erro', 14); await seed('pulado', 101); await seed('ambiguo', 75);
  const lead = (st, intent, desf) => c.query(`INSERT INTO leads (status, intent, desfecho) VALUES ($1,$2,$3)`, [st, intent, desf]);
  await lead('EXPERIMENTAL_AGENDADA', null, null);         // conta (status real de agendamento)
  await lead('QUALIFIED', null, null);                      // NÃO conta mais (era o proxy antigo)
  await lead('QUALIFYING', 'SCHEDULE_INTEREST', null);      // conta (intent)
  await lead('QUALIFYING', null, 'nao_compareceu_aula');    // conta (desfecho)
  await lead('QUALIFYING', null, null);                     // não conta
  await lead('NOT_LEAD', null, 'nao_compareceu_aula');      // fora do universo
});
after(async () => { await c.end(); });

test('(1) taxa envio-sem-erro: exclui pulado(opt-out) e ambiguo(no_match) → 95%, não 70%', async () => {
  const nova = (await c.query(TAXA_NOVA, [1])).rows[0];
  const taxaNova = Math.round(nova.env / (nova.env + nova.erro) * 100);
  assert.equal(nova.env, 273); assert.equal(nova.erro, 14);
  assert.equal(taxaNova, 95, 'nova = 273/(273+14) = 95%');
  // a antiga (contava pulado como falha) daria 70%
  const antiga = (await c.query(TAXA_ANTIGA, [1])).rows[0];
  const taxaAntiga = Math.round(antiga.env / (antiga.env + antiga.falhou) * 100);
  assert.equal(taxaAntiga, 70, 'antiga = 273/(273+115) = 70% (o número falso)');
  assert.ok(taxaNova > taxaAntiga, 'a correção sobe a taxa (deixa de punir opt-out)');
});

test('(2) funil "agendada": conta EXPERIMENTAL_AGENDADA, NÃO conta QUALIFIED', async () => {
  const n = (await c.query(AGENDADAS)).rows[0].n;
  // conta: EXPERIMENTAL_AGENDADA + SCHEDULE_INTEREST + nao_compareceu = 3 ; QUALIFIED puro fica fora
  assert.equal(n, 3, 'EXPERIMENTAL_AGENDADA + intent + nao_compareceu = 3');
  // prova direta: QUALIFIED puro (sem intent/desfecho) não entra
  const soQualified = (await c.query(`SELECT count(*)::int n FROM leads WHERE status='QUALIFIED' AND (intent IS DISTINCT FROM 'SCHEDULE_INTEREST') AND desfecho IS NULL`)).rows[0].n;
  assert.equal(soQualified, 1, 'há 1 QUALIFIED puro no seed');
  const aindaQualified = (await c.query(`${AGENDADAS} AND status='QUALIFIED'`)).rows[0].n;
  assert.equal(aindaQualified, 0, 'nenhum QUALIFIED puro conta como agendada agora');
});

test('(3) multi-tenant/sem-hardcode: expressões sobre status/intent/desfecho e franquia_id', async () => {
  assert.ok(!/tenant|franquia_id\s*=\s*\d/.test(AGENDADAS), 'funil sem tenant/franquia cravado');
  // outra franquia não vaza na taxa
  await c.query(`INSERT INTO envio_log (franquia_id, status) VALUES (2,'erro'),(2,'erro'),(2,'erro')`);
  const f1 = (await c.query(TAXA_NOVA, [1])).rows[0];
  assert.equal(f1.erro, 14, 'franquia 1 não conta erros da franquia 2');
});
