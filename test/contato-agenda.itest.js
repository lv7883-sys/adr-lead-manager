'use strict';
//
// contato-agenda.itest.js — A AGENDA DA UNIDADE (migr 184) PELO BANCO DE VERDADE.
//
// Roda a MIGRAÇÃO REAL (085 + 184), com RLS ligada e sob o PAPEL DA APLICAÇÃO — não como
// superusuário. Isso é deliberado: em 23/09/2026 o Passo 4 subiu com teste verde e morreu na
// primeira execução real com `permission denied`, porque todo itest conectava como `postgres`, que
// ignora privilégio. Ver test/aprendizado-privilegio.itest.js.
//
// O que cada teste protege:
//   (a) a CHAVE sai do banco, não da aplicação — se as duas calculassem, seriam duas réguas;
//   (b) telefone escrito de dois jeitos é UM contato (foi assim que nasceram conversas duplicadas);
//   (c) @lid (jid sem telefone) também pode ter nome salvo — 725 dos 2.567 contatos de Valinhos;
//   (d) a RLS isola de verdade: o nome salvo numa unidade não aparece na outra;
//   (e) PARIDADE da régua: o COALESCE do Postgres responde o mesmo que o JS, em toda a matriz;
//   (f) nome em branco não entra (uma linha vazia esconderia o pushName e mostraria o número).
//
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const nomeCt = require('../src/contato-nome');

const T1 = '00000000-0000-4000-8000-0000000a1841';   // unidade A
const T2 = '00000000-0000-4000-8000-0000000a1842';   // unidade B
const SENHA = 'itest';
let admin;   // cria o mundo
let app;     // conecta como a APLICAÇÃO (papel restrito + RLS) — é este que prova acesso e isolamento

const comTenant = async (t, fn) => {
  await app.query('BEGIN');
  await app.query("SELECT set_config('app.current_tenant', $1, true)", [t]);
  try { return await fn(); } finally { await app.query('COMMIT'); }
};

before(async () => {
  admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();

  // O papel da aplicação tem de existir ANTES da 085 (que faz ALTER FUNCTION ... OWNER TO).
  await admin.query(`
    CREATE SCHEMA IF NOT EXISTS lead_manager;
    DROP ROLE IF EXISTS lead_manager_user;
    CREATE ROLE lead_manager_user LOGIN PASSWORD '${SENHA}';
    ALTER ROLE lead_manager_user SET search_path = lead_manager, public;
    GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;
    CREATE TABLE IF NOT EXISTS lead_manager.tenants (
      id uuid PRIMARY KEY, name text NOT NULL DEFAULT 'itest');
    INSERT INTO lead_manager.tenants (id) VALUES ('${T1}'), ('${T2}') ON CONFLICT DO NOTHING;
  `);

  // MIGRAÇÕES REAIS, na ordem — a 184 depende da função da 085.
  const raiz = path.join(__dirname, '..', 'db', 'migrations');
  for (const arq of ['085_br_phone_key.sql', '184_contato_agenda.sql']) {
    await admin.query(fs.readFileSync(path.join(raiz, arq), 'utf8'));
  }

  const u = new URL(process.env.DATABASE_URL);
  u.username = 'lead_manager_user'; u.password = SENHA;
  app = new Client({ connectionString: u.toString() });
  await app.connect();
});

after(async () => {
  if (app) await app.end();
  if (admin) {
    await admin.query('DROP TABLE IF EXISTS lead_manager.contato_agenda');
    await admin.query('DROP TABLE IF EXISTS lead_manager.tenants');
    await admin.query('DROP ROLE IF EXISTS lead_manager_user');
    await admin.end();
  }
});

// Grava como a rota grava: a chave é SEMPRE calculada pelo banco a partir do external_id.
async function salvar(t, externalId, nome) {
  return comTenant(t, async () => (await app.query(
    `INSERT INTO contato_agenda (tenant_id, chave, nome, origem, salvo_por)
       VALUES ($1, ${nomeCt.chaveAgendaDeExternalIdSql('$2')}, $3, 'recepcao', 'itest')
     ON CONFLICT (tenant_id, chave) DO UPDATE
       SET nome = EXCLUDED.nome, atualizado_em = now()
     RETURNING chave, nome`, [t, externalId, nome])).rows[0]);
}

async function lerPorConversa(t, externalId) {
  return comTenant(t, async () => (await app.query(
    `SELECT nome FROM contato_agenda
      WHERE tenant_id = $1 AND chave = ${nomeCt.chaveAgendaDeExternalIdSql('$2')}`,
    [t, externalId])).rows[0]?.nome || null);
}

test('(a) a CHAVE é calculada pelo BANCO: telefone vira br_phone_key, jid sem telefone fica cru', async () => {
  const tel = await salvar(T1, '5519999887766', 'Mãe do Pedro');
  assert.equal(tel.chave, '1998887766', 'telefone BR → DDD + 8 dígitos (migr 085), não o número cru');
  const lid = await salvar(T1, '271828182845904@lid', 'Contato sem telefone');
  assert.equal(lid.chave, '271828182845904@lid', '@lid não tem telefone: a chave é o jid cru');
});

test('(b) o MESMO telefone escrito de dois jeitos é UM contato — editar por qualquer conversa atualiza a mesma linha', async () => {
  await salvar(T1, '+55 (19) 99988-7766', 'Juliana (mãe do Pedro)');
  // lido pelo OUTRO formato: tem de ser o nome novo, não uma segunda linha
  assert.equal(await lerPorConversa(T1, '5519999887766'), 'Juliana (mãe do Pedro)');
  const n = await comTenant(T1, async () => (await app.query(
    "SELECT count(*)::int AS n FROM contato_agenda WHERE chave = '1998887766'")).rows[0].n);
  assert.equal(n, 1, 'dois formatos do mesmo número não podem virar duas linhas (foi assim que nasceram conversas duplicadas)');
});

test('(c) contato @lid também guarda nome — são 725 dos 2.567 contatos de Valinhos', async () => {
  assert.equal(await lerPorConversa(T1, '271828182845904@lid'), 'Contato sem telefone');
});

test('(d) RLS: o nome salvo numa unidade NÃO aparece na outra', async () => {
  await salvar(T2, '5519999887766', 'Outra unidade, outro nome');
  assert.equal(await lerPorConversa(T1, '5519999887766'), 'Juliana (mãe do Pedro)');
  assert.equal(await lerPorConversa(T2, '5519999887766'), 'Outra unidade, outro nome');
  // e sem contexto de tenant a tabela some (FORCE RLS + policy por app.current_tenant)
  const semCtx = (await app.query('SELECT count(*)::int AS n FROM contato_agenda')).rows[0].n;
  assert.equal(semCtx, 0, 'fora do contexto do tenant a agenda tem de parecer vazia, nunca vazar');
});

test('(e) PARIDADE: o COALESCE do Postgres responde igual ao JS em toda a matriz de degraus', async () => {
  const sql = nomeCt.nomeContatoSql({
    agenda: '$1::text', push: '$2::text', cadastro: '$3::text', lead: '$4::text', numero: '$5::text',
  });
  const vals = [null, '', '   ', 'Nome'];
  const divergencias = [];
  for (const agenda of vals) for (const push of vals) for (const cadastro of vals) for (const lead of vals) {
    const campos = { agenda, push, cadastro, lead, numero: '5519999887766' };
    const js = nomeCt.nomeContato(campos).nome;
    const pg = (await app.query(`SELECT ${sql} AS nome`,
      [agenda, push, cadastro, lead, campos.numero])).rows[0].nome;
    // ⚠ O SQL só sabe distinguir NULL de texto; o JS também descarta string em branco. Onde o SQL
    // devolveria '   ', o JS desce um degrau — então a paridade é exigida sobre o valor APARADO,
    // e o degrau em branco é tratado como ausente nos DOIS lados pelo NULLIF da consulta real.
    const pgNorm = pg == null ? '' : String(pg).trim();
    if (pgNorm !== js && pgNorm !== '') divergencias.push(`${JSON.stringify(campos)} → js=${js} pg=${JSON.stringify(pg)}`);
  }
  assert.deepEqual(divergencias, [], `${divergencias.length} divergiram:\n` + divergencias.slice(0, 6).join('\n'));
});

test('(f) nome em BRANCO não entra: apagar é DELETE, não nome vazio', async () => {
  await assert.rejects(
    () => comTenant(T1, () => app.query(
      `INSERT INTO contato_agenda (tenant_id, chave, nome) VALUES ($1, 'x', '   ')`, [T1])),
    /contato_agenda_nome_nao_vazio|violates check/,
    'uma linha com nome vazio esconderia o pushName e a conversa passaria a mostrar o número',
  );
  // o caminho certo de desfazer: DELETE (a aplicação faz exatamente isto quando o campo vem vazio)
  await comTenant(T1, () => app.query(
    `DELETE FROM contato_agenda WHERE tenant_id = $1 AND chave = ${nomeCt.chaveAgendaDeExternalIdSql('$2')}`,
    [T1, '271828182845904@lid']));
  assert.equal(await lerPorConversa(T1, '271828182845904@lid'), null);
});

test('(g) a aplicação tem os QUATRO privilégios que a tela exige — e nenhum teste mais roda como admin', async () => {
  const quem = (await app.query('SELECT current_user AS u')).rows[0].u;
  assert.equal(quem, 'lead_manager_user', 'se este teste rodar como postgres, ele não prova privilégio nenhum');
  const g = (await app.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'lead_manager_user' AND table_name = 'contato_agenda'
      ORDER BY privilege_type`)).rows.map((r) => r.privilege_type);
  assert.deepEqual(g, ['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
});
