'use strict';
//
// descartados-paridade.itest.js — A LISTA DE DESCARTADOS FICOU 55x MAIS RÁPIDA SEM MUDAR DE RESPOSTA.
//
// Em 26/09/2026 a consulta de Descartados levava 8,0 s e sozinha definia os ~9 s de espera da tela
// de Leads. A causa não era índice faltando: era perguntar 5 coisas ao banco UMA VEZ POR LEAD
// (312x), sendo que uma delas fazia o banco reler as 70.548 amostras de saída do começo. A troca
// (src/descartados.js) pergunta uma vez para todos: 8.017 ms -> 146 ms.
//
// O RISCO DE UMA TROCA DESSAS não é ficar lenta de novo — é a resposta mudar em silêncio. Foi a
// pergunta que o Leo fez antes de autorizar: "o que perdemos de informação, se é que perdemos?".
// A resposta foi medida contra a produção (313 linhas x 16 colunas, zero diferenças), e é ESTE
// arquivo que impede a resposta de escorregar depois. Por isso a consulta ANTIGA está congelada
// aqui como ORÁCULO: não é código morto, é a régua contra a qual a nova responde.
//
// ⚠ Se um dia a lista PRECISAR mudar de resposta (regra nova de negócio), o certo é mudar o
//   oráculo junto, no mesmo commit, com o porquê escrito. O que não pode é mudar de um lado só.
//
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { naoEhReacaoSql } = require('../src/reacao');
const { bolaSql } = require('../src/bola');
const { DESCARTADOS_SQL } = require('../src/descartados');

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTRO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let adm;   // superusuário: monta o cenário (enxerga tudo, como o DBA)
let c;     // lead_manager_user: LÊ como a aplicação lê, com RLS valendo
const entrarNaUnidade = (tid) => c.query("SELECT set_config('app.current_tenant', $1, false)", [tid]);

// ---------------------------------------------------------------------------------------------
// ORÁCULO: a consulta como ela era até 26/09/2026, palavra por palavra (só o schema foi
// qualificado). Subconsulta correlacionada por lead — lenta, mas é a régua que a tela usava.
// ---------------------------------------------------------------------------------------------
const _IDENT = "regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')";
const ORACULO = `SELECT 'lead' AS kind, l.id::text AS id, coalesce(l.phone, l.meta_psid) AS phone, l.name,
         l.classification_confidence AS confidence, 'low_confidence' AS reason,
         l.classification_reasoning AS reasoning,
         COALESCE(l.intent, CASE WHEN l.classification_signals->>0 = 'CANDIDATO' THEN 'CANDIDATO' END) AS intent,
         l.conversation_state, l.state_reasoning,
         ${bolaSql({
    lastInTurno: `(SELECT max(m.received_at) FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
                    WHERE cv.tenant_id = $1 AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = ${_IDENT}
                      AND m.role = 'USER' AND ${naoEhReacaoSql('m')})`,
    lastOut: `(SELECT max(s.received_at) FROM staff_outbound_samples s
                WHERE s.tenant_id = $1 AND regexp_replace(s.external_id, '[^0-9]', '', 'g') = ${_IDENT})`,
  })} AS bola,
         CASE WHEN l.review_result = 'confirmed_not_lead' THEN 'recepcao' ELSE 'ia' END AS origem_descarte,
         coalesce(l.review_em, l.created_at) AS descartado_em,
         (SELECT min(m.received_at) FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
           WHERE cv.tenant_id = $1 AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = ${_IDENT} AND m.role = 'USER') AS received_at,
         (SELECT m.body FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
           WHERE cv.tenant_id = $1 AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = ${_IDENT} AND m.role = 'USER'
           ORDER BY m.received_at ASC LIMIT 1) AS first_message,
         (SELECT cv.channel FROM conversations cv
           WHERE cv.tenant_id = $1 AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = ${_IDENT}
           ORDER BY cv.updated_at DESC LIMIT 1) AS channel
    FROM leads l
   WHERE l.status = 'NOT_LEAD' AND l.desfecho IS NULL
     AND (l.review_result IS NULL OR l.review_result = 'confirmed_not_lead')
   ORDER BY coalesce(l.review_em, l.created_at) DESC NULLS LAST
   LIMIT 1000`;

// --- schema mínimo, no shape de produção (só o que as duas consultas tocam) -------------------
const SCHEMA = `
CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, name text, phone text,
  meta_psid text, status text, desfecho text, review_result text, review_em timestamptz,
  created_at timestamptz DEFAULT now(), classification_confidence numeric, classification_reasoning text,
  classification_signals jsonb, intent text, conversation_state text, state_reasoning text,
  state_computed_at timestamptz);
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, external_id text,
  channel text, updated_at timestamptz DEFAULT now());
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, conversation_id uuid,
  role text, body text, received_at timestamptz);
CREATE TABLE staff_outbound_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, external_id text,
  received_at timestamptz);`;

// ⚠ RLS DE VERDADE, igual à de produção (policy tenant_isolation, comparando com
// app.current_tenant). Não é preciosismo: a CTE `alvo` NÃO filtra tenant_id na cláusula WHERE —
// quem separa as unidades ali é o RLS, exatamente como na consulta antiga. Um teste sem RLS
// passaria verde e não provaria o isolamento, que é a coisa mais cara de errar aqui. Rodamos como
// um papel comum (sem BYPASSRLS) porque superusuário ignora política — foi assim que um "zero
// linhas" já enganou este projeto antes.
const RLS = ['leads', 'conversations', 'messages', 'staff_outbound_samples'].map((t) => `
  ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
  ALTER TABLE ${t} OWNER TO lead_manager_user;
  CREATE POLICY tenant_isolation ON ${t} USING
    (tenant_id = (NULLIF(current_setting('app.current_tenant', true), ''))::uuid);`).join('\n');

const D = (dia) => `2026-09-${String(dia).padStart(2, '0')}T12:00:00Z`;

// Um descartado + sua conversa + suas mensagens + (talvez) resposta da recepção.
// ⚠ cada lead nasce num dia DIFERENTE (criadoEm cresce sozinho): no mundo real as datas de
// descarte são distintas, e datas empatadas deixariam a ordem indefinida — o que mascararia uma
// troca de ordem de verdade. O empate tem teste próprio, mais abaixo.
let _dia = 0;
async function cenario({ nome, phone = null, psid = null, extId = phone, canal = 'whatsapp',
  msgs = [], saidaEm = null, review = null, estado = null, estadoEm = null, criadoEm = null }) {
  criadoEm = criadoEm || D(1 + (_dia += 1));
  const l = (await adm.query(
    `INSERT INTO leads (tenant_id, name, phone, meta_psid, status, review_result, created_at,
                        conversation_state, state_computed_at, classification_confidence, classification_signals)
     VALUES ($1,$2,$3,$4,'NOT_LEAD',$5,$6,$7,$8,0.2,$9) RETURNING id`,
    [T, nome, phone, psid, review, criadoEm, estado, estadoEm, JSON.stringify(['CANDIDATO'])])).rows[0].id;
  if (extId) {
    const cv = (await adm.query(
      `INSERT INTO conversations (tenant_id, external_id, channel, updated_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [T, extId, canal, D(20)])).rows[0].id;
    for (const m of msgs) {
      await adm.query(`INSERT INTO messages (tenant_id, conversation_id, role, body, received_at) VALUES ($1,$2,$3,$4,$5)`,
        [T, cv, m.role || 'USER', m.body, m.em]);
    }
  }
  if (saidaEm) {
    await adm.query(`INSERT INTO staff_outbound_samples (tenant_id, external_id, received_at) VALUES ($1,$2,$3)`,
      [T, extId, saidaEm]);
  }
  return l;
}

before(async () => {
  adm = new Client({ connectionString: process.env.DATABASE_URL });   // superusuário: monta o cenário
  await adm.connect();
  await adm.query("CREATE ROLE lead_manager_user LOGIN PASSWORD 'itest'").catch(() => {});
  await adm.query(SCHEMA);
  await adm.query(RLS);
  await adm.query('GRANT USAGE ON SCHEMA public TO lead_manager_user');
  await adm.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lead_manager_user');
  c = new Client({ connectionString: process.env.DATABASE_URL_APP });   // lê como a aplicação lê
  await c.connect();
  await entrarNaUnidade(T);

  // --- a matriz de casos: cada um existe por um motivo -----------------------------------------
  // (1) o caso comum: cliente escreveu, ninguém respondeu -> a bola é NOSSA
  await cenario({ nome: 'Escreveu e ninguem respondeu', phone: '+5519911110001',
    msgs: [{ body: 'oi, quero aula de violao', em: D(2) }, { body: 'alguem ai?', em: D(3) }] });
  // (2) a recepção respondeu DEPOIS -> a bola é do CLIENTE. É o caso que a subconsulta cara servia.
  await cenario({ nome: 'Recepcao respondeu depois', phone: '+5519922220002',
    msgs: [{ body: 'bom dia', em: D(2) }], saidaEm: D(4) });
  // (3) TELEFONE EM GRAFIA DIFERENTE entre lead e conversa: o casamento é por DÍGITOS, tem que casar.
  //     ⚠ mesmos dígitos dos dois lados, incluindo o DDI: esta régua compara dígito a dígito e NÃO
  //     normaliza o 55 (quem faz isso é br_phone_key, que esta consulta não usa). '19933330003' e
  //     '5519933330003' são telefones DIFERENTES para ela — e sempre foram, aqui e no oráculo.
  await cenario({ nome: 'Grafia diferente', phone: '+55 (19) 9 3333-0003', extId: '5519933330003',
    msgs: [{ body: 'quanto custa?', em: D(5) }] });
  // (4) REAÇÃO NÃO É TURNO: o ❤️ é a última mensagem, mas não conta como vez do cliente.
  //     Se a janela do FILTER escorregar, este caso muda de bola — foi um incidente real.
  await cenario({ nome: 'Ultima msg e reacao', phone: '+5519944440004',
    msgs: [{ body: 'obrigada!', em: D(2) }, { body: '[reação] ❤️', em: D(6) }], saidaEm: D(4) });
  // (5) SEM NENHUMA MENSAGEM: tudo derivado tem que vir null, sem sumir da lista
  await cenario({ nome: 'Sem mensagem nenhuma', phone: '+5519955550005' });
  // (6) SEM TELEFONE E SEM PSID (ident vazio) — o caso de borda que a versão nova trata melhor
  await cenario({ nome: 'Sem telefone', phone: null, psid: null, extId: null });
  // (7) canal META (psid, não telefone): a lista serve os dois
  await cenario({ nome: 'Veio do Instagram', psid: '17841400000001', extId: '17841400000001',
    canal: 'instagram_dm', msgs: [{ body: 'oi', em: D(7) }] });
  // (8) descartado PELA RECEPÇÃO (não pela IA) -> origem_descarte = 'recepcao'
  await cenario({ nome: 'Recepcao disse que nao e lead', phone: '+5519966660006',
    review: 'confirmed_not_lead', msgs: [{ body: 'e o curriculo?', em: D(8) }] });
  // (9) com veredito FRESCO da IA -> a bola sai do estado gravado, não do cálculo por datas
  await cenario({ nome: 'Estado fresco da IA', phone: '+5519977770007',
    estado: 'AGUARDANDO_CLIENTE', estadoEm: D(9), msgs: [{ body: 'vou pensar', em: D(8) }] });
  // (10) veredito VELHO: cliente escreveu depois do carimbo -> o estado não vale mais
  await cenario({ nome: 'Estado velho da IA', phone: '+5519988880008',
    estado: 'AGUARDANDO_CLIENTE', estadoEm: D(3), msgs: [{ body: 'voltei', em: D(10) }] });
  // (11) DOIS LEADS NO MESMO TELEFONE (grafias diferentes): o agrupamento por ident não pode
  //      fundir os dois nem trocar as respostas entre eles
  await cenario({ nome: 'Mesmo numero A', phone: '+5519999990009', msgs: [{ body: 'primeira', em: D(11) }] });
  await cenario({ nome: 'Mesmo numero B', phone: '5519999990009', extId: null });
  // (12) NÃO É DESCARTADO: tem desfecho -> não pode aparecer em nenhuma das duas
  await adm.query(`INSERT INTO leads (tenant_id, name, phone, status, desfecho, created_at)
                 VALUES ($1,'Ja tem desfecho','+5519900000010','NOT_LEAD','nao_matriculado_preco',$2)`, [T, D(1)]);
  // (13) NÃO É DESCARTADO: está na fila de revisão com outro resultado
  await adm.query(`INSERT INTO leads (tenant_id, name, phone, status, review_result, created_at)
                 VALUES ($1,'Confirmado lead','+5519900000011','NOT_LEAD','confirmed_lead',$2)`, [T, D(1)]);
  // (14) NÃO É DESCARTADO: é lead ativo
  await adm.query(`INSERT INTO leads (tenant_id, name, phone, status, created_at)
                 VALUES ($1,'Lead ativo','+5519900000012','QUALIFICANDO',$2)`, [T, D(1)]);
});
after(async () => { await c.end(); await adm.end(); });

const norm = (v) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

test('PARIDADE: a consulta nova responde EXATAMENTE o que a antiga respondia', async () => {
  const antes = (await c.query(ORACULO, [T])).rows;
  const depois = (await c.query(DESCARTADOS_SQL, [T])).rows;

  assert.equal(depois.length, antes.length, 'número de linhas mudou — alguém entrou ou sumiu da lista');
  assert.ok(antes.length >= 12, 'cenário não montou (teste que não testa nada é pior que teste nenhum)');

  const colunas = Object.keys(antes[0]);
  assert.equal(colunas.length, 16, 'o payload mudou de forma — confira se a tela ainda recebe o que espera');

  const divergencias = [];
  for (let i = 0; i < antes.length; i++) {
    if (antes[i].id !== depois[i].id) {
      divergencias.push(`posicao ${i}: ORDEM mudou (${antes[i].name} -> ${depois[i].name})`);
      continue;
    }
    for (const k of colunas) {
      if (norm(antes[i][k]) !== norm(depois[i][k])) {
        divergencias.push(`${antes[i].name} | ${k}: antes=${norm(antes[i][k])} depois=${norm(depois[i][k])}`);
      }
    }
  }
  assert.deepEqual(divergencias, [],
    `${divergencias.length} divergência(s):\n` + divergencias.slice(0, 10).join('\n'));
});

test('a lista traz quem é descartado e SÓ quem é descartado', async () => {
  const nomes = (await c.query(DESCARTADOS_SQL, [T])).rows.map((r) => r.name);
  for (const fora of ['Ja tem desfecho', 'Confirmado lead', 'Lead ativo']) {
    assert.ok(!nomes.includes(fora), `${fora} não deveria estar na rede de resgate`);
  }
  // invariante do ADR-019: quem foi descartado e não teve decisão de resultado TEM que aparecer
  assert.ok(nomes.includes('Sem telefone'), 'lead sem telefone não pode virar limbo invisível');
  assert.ok(nomes.includes('Sem mensagem nenhuma'), 'lead sem mensagem também é resgatável');
});

test('os campos derivados continuam certos (não só iguais ao oráculo)', async () => {
  const por = new Map((await c.query(DESCARTADOS_SQL, [T])).rows.map((r) => [r.name, r]));

  // quem escreveu e não foi respondido: a bola é nossa
  assert.equal(por.get('Escreveu e ninguem respondeu').bola, 'nossa');
  // quem foi respondido depois: a bola é do cliente
  assert.equal(por.get('Recepcao respondeu depois').bola, 'cliente');
  // REAÇÃO NÃO É TURNO: o ❤️ chegou DEPOIS da resposta da recepção, e ainda assim a bola
  // não volta para nós — senão a fila mandaria "responder agora" um lead já respondido.
  assert.equal(por.get('Ultima msg e reacao').bola, 'cliente', 'reação não devolve a bola');
  // primeira mensagem = a mais antiga, com o corpo dela
  assert.equal(por.get('Escreveu e ninguem respondeu').first_message, 'oi, quero aula de violao');
  assert.equal(norm(por.get('Escreveu e ninguem respondeu').received_at), new Date(D(2)).toISOString());
  // telefone em grafia diferente casa mesmo assim
  assert.equal(por.get('Grafia diferente').first_message, 'quanto custa?');
  // sem mensagem: derivados nulos, e a linha continua na lista
  assert.equal(por.get('Sem mensagem nenhuma').first_message, null);
  assert.equal(por.get('Sem mensagem nenhuma').received_at, null);
  // canal vem da conversa
  assert.equal(por.get('Veio do Instagram').channel, 'instagram_dm');
  assert.equal(por.get('Escreveu e ninguem respondeu').channel, 'whatsapp');
  // quem descartou
  assert.equal(por.get('Recepcao disse que nao e lead').origem_descarte, 'recepcao');
  assert.equal(por.get('Escreveu e ninguem respondeu').origem_descarte, 'ia');
});

test('EMPATE de data: mesmo conjunto, e a ordem não muda a cada consulta', async () => {
  // Foi o teste de paridade que descobriu isto, empatando as datas sem querer: sem desempate, o
  // Postgres não promete ordem nenhuma entre iguais, e a lista da recepção podia trocar de ordem
  // a cada F5. A consulta nova desempata por id; a antiga não desempatava. Logo, em empate as duas
  // trazem o MESMO CONJUNTO (é o que importa: ninguém some), e a nova ainda é ESTÁVEL.
  const dia = D(28);
  for (const n of ['Empate A', 'Empate B', 'Empate C']) {
    await adm.query(`INSERT INTO leads (tenant_id, name, phone, status, created_at)
                     VALUES ($1,$2,NULL,'NOT_LEAD',$3)`, [T, n, dia]);
  }
  try {
    const idsDe = (rows) => rows.map((r) => r.id).sort().join(',');
    const antes = (await c.query(ORACULO, [T])).rows;
    const depois1 = (await c.query(DESCARTADOS_SQL, [T])).rows;
    const depois2 = (await c.query(DESCARTADOS_SQL, [T])).rows;
    assert.equal(idsDe(depois1), idsDe(antes), 'o conjunto mudou — alguém sumiu ou apareceu');
    assert.deepEqual(depois1.map((r) => r.id), depois2.map((r) => r.id),
      'a mesma consulta devolveu ordens diferentes — a lista dança na tela');
    const empatados = depois1.filter((r) => r.name.startsWith('Empate')).map((r) => r.name);
    assert.equal(empatados.length, 3, 'os três empatados continuam na lista');
  } finally {
    await adm.query(`DELETE FROM leads WHERE tenant_id=$1 AND name LIKE 'Empate %'`, [T]);
  }
});

test('BORDA: lead sem telefone não herda a conversa de ninguém', async () => {
  // A versão antiga casava ident vazio com ident vazio — se um dia entrar uma conversa cujo
  // external_id não tenha dígito nenhum, ela seria colada em TODOS os leads sem telefone.
  // É a mesma família da "conversa fantasma de grupo". Aqui isso não pode acontecer.
  await adm.query(`INSERT INTO conversations (tenant_id, external_id, channel) VALUES ($1,'@@sem-digito@@','whatsapp')`, [T]);
  const cv = (await adm.query(`SELECT id FROM conversations WHERE external_id='@@sem-digito@@'`)).rows[0].id;
  await adm.query(`INSERT INTO messages (tenant_id, conversation_id, role, body, received_at)
                 VALUES ($1,$2,'USER','mensagem de ninguem',$3)`, [T, cv, D(15)]);
  try {
    const sem = (await c.query(DESCARTADOS_SQL, [T])).rows.find((r) => r.name === 'Sem telefone');
    assert.equal(sem.first_message, null, 'lead sem telefone não pode receber mensagem de outra conversa');
    assert.equal(sem.channel, null);
    assert.equal(sem.bola, 'indefinida');
  } finally {
    await adm.query(`DELETE FROM messages WHERE conversation_id=$1`, [cv]);
    await adm.query(`DELETE FROM conversations WHERE id=$1`, [cv]);
  }
});

test('ISOLAMENTO: a lista de um tenant não enxerga o outro', async () => {
  // MESMO TELEFONE que o lead (1) do tenant A — de propósito: é assim que um vazamento apareceria,
  // como um dado plausível (a primeira mensagem "do vizinho"), não como erro.
  await adm.query(`INSERT INTO leads (tenant_id, name, phone, status, created_at)
                 VALUES ($1,'Descartado de outra unidade','+5519911110001','NOT_LEAD',$2)`, [OUTRO, D(1)]);
  try {
    const nomes = (await c.query(DESCARTADOS_SQL, [T])).rows.map((r) => r.name);
    assert.ok(!nomes.includes('Descartado de outra unidade'), 'vazou lead de outro tenant');
    // e, do lado de lá, o telefone repetido não traz as mensagens do vizinho
    await entrarNaUnidade(OUTRO);
    const outros = (await c.query(DESCARTADOS_SQL, [OUTRO])).rows;
    assert.equal(outros.length, 1, 'a outra unidade tem que ver só o lead dela');
    assert.equal(outros[0].first_message, null, 'casou com a conversa do tenant errado');
  } finally {
    await entrarNaUnidade(T);
    await adm.query(`DELETE FROM leads WHERE tenant_id=$1`, [OUTRO]);
  }
});
