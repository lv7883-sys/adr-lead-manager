'use strict';
//
// aprendizado-privilegio.itest.js — A CONSULTA RODA COM O USUÁRIO DA APLICAÇÃO, NÃO COMO ADMIN.
//
// O INCIDENTE (23/09/2026, no próprio deploy do Passo 4): o código estava certo, os testes estavam
// verdes, o container subiu saudável — e o relatório morria na primeira execução real com
// `permission denied for table campanha_alvo`. O `lead_manager_user` não tinha SELECT na tabela
// que a consulta usa para EXCLUIR disparo de campanha.
//
// POR QUE NENHUM TESTE PEGOU: todos os itests conectam como `postgres`, que é superusuário e
// ignora privilégio. O teste provava a lógica e não provava o acesso — garantia parcial que
// parecia completa. A sessão de origem de leads levou a mesma mordida em 21/09, pelo lado oposto
// (um privilégio a MAIS: `ALTER DEFAULT PRIVILEGES` de produção dava DELETE a toda tabela nova).
// Mesma causa, direções opostas: **o banco descartável não reproduz os privilégios de produção**.
//
// Este teste é a regra do dia aplicada a si mesma — toda trava nova testada contra o incidente que
// a gerou, com o caso verdadeiro: cria o papel restrito, concede EXATAMENTE o que as migrações 176
// e 177 concedem, e roda a consulta real por ele. Se alguém acrescentar uma tabela à consulta e
// esquecer o GRANT, quebra aqui em vez de quebrar em produção.
//
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const apr = require('../src/aprendizado');

const T = '00000000-0000-4000-8000-00000000a12a';
const SENHA = 'itest';
let admin;      // cria o mundo
let app;        // conecta como a APLICAÇÃO — é este que prova o acesso

before(async () => {
  admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();

  // O mundo mínimo, com os MESMOS grants das migrações (176 e 177).
  await admin.query(`
    CREATE SCHEMA IF NOT EXISTS lead_manager;
    CREATE SCHEMA IF NOT EXISTS app;
    DROP ROLE IF EXISTS lm_app_itest;
    CREATE ROLE lm_app_itest LOGIN PASSWORD '${SENHA}';
    ALTER ROLE lm_app_itest SET search_path = lead_manager, public;

    CREATE TABLE IF NOT EXISTS lead_manager.conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_id text);
    CREATE TABLE IF NOT EXISTS lead_manager.staff_outbound_samples (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_id text,
      external_message_id text, source text, body text, received_at timestamptz DEFAULT now());
    CREATE TABLE IF NOT EXISTS lead_manager.sugestao_ia (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, conversation_id uuid,
      lead_id uuid, origem text, contexto text, texto text, modelo text, pedida_por text,
      criada_em timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS app.campanha_alvo (
      id bigserial PRIMARY KEY, wa_message_id text);

    GRANT USAGE ON SCHEMA lead_manager TO lm_app_itest;
    GRANT SELECT ON lead_manager.conversations, lead_manager.staff_outbound_samples TO lm_app_itest;
    -- migração 176: a aplicação só lê e insere a própria tabela
    GRANT SELECT, INSERT ON lead_manager.sugestao_ia TO lm_app_itest;
    -- migração 177: privilégio no tamanho da PERGUNTA, não da tabela — duas colunas, só leitura
    GRANT USAGE ON SCHEMA app TO lm_app_itest;
    GRANT SELECT (id, wa_message_id) ON app.campanha_alvo TO lm_app_itest;
  `);

  const u = new URL(process.env.DATABASE_URL);
  u.username = 'lm_app_itest'; u.password = SENHA;
  app = new Client({ connectionString: u.toString() });
  await app.connect();
});

after(async () => {
  if (app) await app.end();
  if (admin) { await admin.query('DROP OWNED BY lm_app_itest CASCADE; DROP ROLE IF EXISTS lm_app_itest;').catch(() => {}); await admin.end(); }
});

test('a consulta do relatório roda com o usuário da APLICAÇÃO (era aqui que produção quebrava)', async () => {
  // Este é o teste que teria evitado o incidente: como `postgres`, ele passaria mesmo sem o GRANT.
  const r = await app.query(apr.sqlSugestoesComResposta(), [T, 30]);
  assert.ok(Array.isArray(r.rows), 'a consulta executou sob o papel restrito');
});

test('a aplicação consegue GRAVAR a sugestão (o caminho que nunca pode falhar)', async () => {
  // A gravação é best-effort no código, então uma falha aqui sairia só como aviso no log e o
  // aprendizado morreria em silêncio — o pior modo de falhar. Por isso tem teste próprio.
  const cv = (await admin.query(
    `INSERT INTO lead_manager.conversations (tenant_id, external_id) VALUES ($1,'5519999999999') RETURNING id`, [T])).rows[0].id;
  await app.query(
    `INSERT INTO lead_manager.sugestao_ia (tenant_id, conversation_id, origem, contexto, texto)
     VALUES ($1,$2,'inbox','lead','Olá! Posso reservar sua aula experimental?')`, [T, cv]);
  const n = (await app.query('SELECT count(*)::int AS n FROM lead_manager.sugestao_ia WHERE tenant_id=$1', [T])).rows[0].n;
  assert.equal(n, 1);
});

test('a aplicação NÃO pode apagar sugestão — é registro histórico', async () => {
  // A migração 176 concede só SELECT e INSERT de propósito. Se alguém acrescentar DELETE sem
  // pensar (ou se o ALTER DEFAULT PRIVILEGES do schema voltar a conceder tudo, como mordeu a
  // frente de origem em 21/09), este teste avisa.
  await assert.rejects(
    () => app.query('DELETE FROM lead_manager.sugestao_ia WHERE tenant_id=$1', [T]),
    /permission denied|permissão negada/i);
});

test('o disparo de campanha é excluído DE VERDADE, com o usuário restrito', async () => {
  const cv = (await admin.query(
    `INSERT INTO lead_manager.conversations (tenant_id, external_id) VALUES ($1,'5519988887777') RETURNING id`, [T])).rows[0].id;
  const sug = 'Temos turma de violão às terças, quer que eu reserve?';
  await admin.query(
    `INSERT INTO lead_manager.sugestao_ia (tenant_id, conversation_id, origem, contexto, texto, criada_em)
     VALUES ($1,$2,'inbox','lead',$3, now() - interval '2 hours')`, [T, cv, sug]);
  // o convite do Rock Hour sai DEPOIS da sugestão, com o MESMO source da recepcionista
  await admin.query(
    `INSERT INTO lead_manager.staff_outbound_samples (tenant_id, external_id, external_message_id, source, body, received_at)
     VALUES ($1,'5519988887777','WAMID_CAMPANHA','api','🥁 ROCK HOUR · 08 DE NOVEMBRO', now() - interval '1 hour')`, [T]);
  await admin.query(`INSERT INTO app.campanha_alvo (wa_message_id) VALUES ('WAMID_CAMPANHA')`);

  const r = await app.query(apr.sqlSugestoesComResposta(), [T, 30]);
  const linha = r.rows.find((x) => x.sugerido === sug);
  assert.ok(linha, 'a sugestão aparece no relatório');
  assert.equal(linha.enviado, null,
    'o disparo de campanha NÃO pode ser comparado com a sugestão — a IA levaria a culpa por uma mensagem automática');
  assert.equal(apr.desfechoDaSugestao(linha.sugerido, linha.enviado).desfecho, apr.NAO_RESPONDEU);
});
