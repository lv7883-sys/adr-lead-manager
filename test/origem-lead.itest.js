'use strict';
// origem-lead.itest.js — origem do 1º toque contra Postgres real (migrações 170/171).
// Roda por `make test-origem` (Postgres descartável, porta 5433). A aplicação conecta como
// lead_manager_user: a RLS testada aqui é a MESMA de produção, não uma imitação.
//
//   DATABASE_URL        = lead_manager_user  (o que a aplicação usa; RLS vale)
//   ADMIN_DATABASE_URL  = postgres           (só para montar cenário e espiar sem RLS)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const origemLead = require('../src/origemLead');
const { pool, withTenant } = require('../src/db');

const T1 = process.env.ISO_TENANT_A || process.env.LS_TENANT_A || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T2 = process.env.ISO_TENANT_B || process.env.LS_TENANT_B || 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Logger mudo: o teste não precisa do JSON do logger na saída.
const mudo = { info() {}, warn() {}, error() {} };

let adm;

const AD = (id) => ({ sourceId: id, sourceUrl: 'https://fb.me/2x', title: 'Aulas de bateria', body: 'Experimental grátis' });
const payload = (telefone, texto, ad) => ({
  event: 'messages.upsert',
  data: {
    key: { remoteJid: `${telefone}@s.whatsapp.net`, fromMe: false, id: `WA${Math.random().toString(36).slice(2, 10)}` },
    pushName: 'Maria',
    message: ad
      ? { extendedTextMessage: { text: texto, contextInfo: { externalAdReply: ad } } }
      : { conversation: texto },
  },
});
const msgDe = (telefone, texto) => ({ externalId: telefone, body: texto });

async function linhas(tenantId) {
  return withTenant(tenantId, async (c) => (await c.query(
    `SELECT * FROM origem_lead ORDER BY capturado_em`)).rows);
}

before(async () => {
  adm = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await adm.connect();
  await adm.query('TRUNCATE lead_manager.origem_lead, lead_manager.mapa_campanha, lead_manager.leads');
  // de-para: um código nosso e um anúncio da Meta, mais um código já VENCIDO.
  await adm.query(
    `INSERT INTO lead_manager.mapa_campanha
       (tenant_id, codigo_campanha, anuncio_id, campanha_ref, motor, objetivo, publico, criativo, valido_de, valido_ate)
     VALUES
       ($1,'RK3','120210000000000001','bateria-set','meta','mensagens','pais-8-12','video-15s', NULL, NULL),
       ($1,'RK9','120210000000000009','violao-jul','meta','mensagens','adultos','carrossel','2026-07-01','2026-07-31'),
       ($2,'RK3',NULL,'DA OUTRA UNIDADE','meta',NULL,NULL,NULL,NULL,NULL)`,
    [T1, T2]);
});

after(async () => {
  await adm.end().catch(() => {});
  await pool.end().catch(() => {});
});

// ── os 4 metodo ──────────────────────────────────────────────────────────────────

test('(1) external_ad_reply: grava o anúncio e deriva a campanha pelo anuncio_id', async () => {
  const tel = '5519990000001';
  const r = await origemLead.registrarOrigem(T1, msgDe(tel, 'Oi, vi o anúncio'),
    payload(tel, 'Oi, vi o anúncio', AD('120210000000000001')), mudo);
  assert.deepEqual(r, { gravado: true, metodo: 'anuncio_meta' });

  const [l] = (await linhas(T1)).filter((x) => x.telefone === tel);
  assert.equal(l.metodo, 'anuncio_meta');
  assert.equal(l.anuncio_id, '120210000000000001');
  assert.equal(l.anuncio_titulo, 'Aulas de bateria');
  assert.equal(l.anuncio_url, 'https://fb.me/2x');
  assert.equal(l.codigo_campanha, null);
  assert.equal(l.campanha_ref, 'bateria-set');   // 2ª chance: casou pelo id do anúncio
  assert.equal(l.publico, 'pais-8-12');
  assert.equal(l.lead_id, null);                 // o lead ainda não existe — e isso é o esperado
  assert.equal(l.chave_contato, '1999000001');     // br_phone_key: sem 55, sem 9º dígito
  assert.equal(l.payload_bruto.data.key.remoteJid, `${tel}@s.whatsapp.net`);
});

test('(2) codigo_campanha: código no texto deriva a campanha', async () => {
  const tel = '5519990000002';
  const r = await origemLead.registrarOrigem(T1, msgDe(tel, 'Quero saber mais [RK3]'),
    payload(tel, 'Quero saber mais [RK3]'), mudo);
  assert.equal(r.metodo, 'codigo_campanha');
  const [l] = (await linhas(T1)).filter((x) => x.telefone === tel);
  assert.equal(l.codigo_campanha, 'RK3');
  assert.equal(l.anuncio_id, null);
  assert.equal(l.campanha_ref, 'bateria-set');
  assert.equal(l.criativo, 'video-15s');
});

test('(3) os dois juntos: grava ambos e os derivados vêm do CÓDIGO', async () => {
  const tel = '5519990000003';
  // anúncio de OUTRA campanha (RK9) + código RK3 no texto: quem manda é o código.
  await origemLead.registrarOrigem(T1, msgDe(tel, 'Quero saber mais [RK3]'),
    payload(tel, 'Quero saber mais [RK3]', AD('120210000000000009')), mudo);
  const [l] = (await linhas(T1)).filter((x) => x.telefone === tel);
  assert.equal(l.metodo, 'codigo_campanha');
  assert.equal(l.codigo_campanha, 'RK3');
  assert.equal(l.anuncio_id, '120210000000000009');   // o anúncio não se perde
  assert.equal(l.campanha_ref, 'bateria-set');          // mas a campanha é a do código
});

test('(4) none: sem anúncio e sem código, o payload bruto é gravado assim mesmo', async () => {
  const tel = '5519990000004';
  const p = payload(tel, 'Bom dia, tem aula de violão?');
  const r = await origemLead.registrarOrigem(T1, msgDe(tel, 'Bom dia, tem aula de violão?'), p, mudo);
  assert.equal(r.metodo, 'nenhum');
  const [l] = (await linhas(T1)).filter((x) => x.telefone === tel);
  assert.equal(l.metodo, 'nenhum');
  assert.equal(l.campanha_ref, null);
  assert.equal(l.payload_bruto.data.message.conversation, 'Bom dia, tem aula de violão?');
});

// ── primeiro toque: a segunda mensagem não sobrescreve ─────────────────────────────────

test('(5) 2ª mensagem do mesmo contato NÃO sobrescreve a origem', async () => {
  const tel = '5519990000005';
  await origemLead.registrarOrigem(T1, msgDe(tel, 'vim do anúncio [RK3]'),
    payload(tel, 'vim do anúncio [RK3]'), mudo);
  // depois ela clica em OUTRO anúncio e escreve de novo
  const segunda = await origemLead.registrarOrigem(T1, msgDe(tel, 'agora vi este [RK9]'),
    payload(tel, 'agora vi este [RK9]', AD('120210000000000009')), mudo);
  assert.equal(segunda.gravado, false, 'a 2ª mensagem não grava linha nova');

  const doContato = (await linhas(T1)).filter((x) => x.chave_contato === '1999000005');
  assert.equal(doContato.length, 1, 'uma linha por contato');
  assert.equal(doContato[0].codigo_campanha, 'RK3');
  assert.equal(doContato[0].anuncio_id, null, 'o 1º toque continua intacto');
});

test('(6) o mesmo telefone em outro formato é o MESMO contato (br_phone_key)', async () => {
  await origemLead.registrarOrigem(T1, msgDe('5519991230000', 'primeira [RK3]'),
    payload('5519991230000', 'primeira [RK3]'), mudo);
  // sem DDI e sem o 9º dígito — o formato que o WhatsApp às vezes manda
  const outra = await origemLead.registrarOrigem(T1, msgDe('1991230000', 'de novo [RK9]'),
    payload('1991230000', 'de novo [RK9]'), mudo);
  assert.equal(outra.gravado, false);
  assert.equal((await linhas(T1)).filter((x) => x.chave_contato === '1991230000').length, 1);
});

// ── vínculo com o lead que nasce DEPOIS ────────────────────────────────────────────────

test('(7) vincularLead liga a origem ao lead criado depois — e é idempotente', async () => {
  const tel = '5519990000007';
  await origemLead.registrarOrigem(T1, msgDe(tel, 'oi [RK3]'), payload(tel, 'oi [RK3]'), mudo);
  const leadId = (await adm.query(
    `INSERT INTO lead_manager.leads (tenant_id, name, phone) VALUES ($1,'Maria',$2) RETURNING id`,
    [T1, tel])).rows[0].id;

  assert.deepEqual(await origemLead.vincularLead(T1, tel, mudo), { vinculado: 1 });
  assert.deepEqual(await origemLead.vincularLead(T1, tel, mudo), { vinculado: 0 }, 'não religa o que já ligou');

  const origem = await origemLead.origemDoLead(T1, leadId);
  assert.equal(origem.campanha_ref, 'bateria-set');
  assert.equal(origem.metodo, 'codigo_campanha');
});

test('(8) um lead nunca tem duas origens (índice único parcial)', async () => {
  const leadId = (await adm.query(
    `INSERT INTO lead_manager.leads (tenant_id, name, phone) VALUES ($1,'Duplo','5519990000008') RETURNING id`,
    [T1])).rows[0].id;
  await adm.query(
    `UPDATE lead_manager.origem_lead SET lead_id = $2 WHERE tenant_id = $1 AND chave_contato = '1999000001'`,
    [T1, leadId]);
  await assert.rejects(
    adm.query(`UPDATE lead_manager.origem_lead SET lead_id = $2 WHERE tenant_id = $1 AND chave_contato = '1999000002'`,
      [T1, leadId]),
    /duplicate key|uq_origem_lead_lead/);
  await adm.query(`UPDATE lead_manager.origem_lead SET lead_id = NULL WHERE tenant_id = $1 AND chave_contato = '1999000001'`, [T1]);
});

// ── a origem é imutável ────────────────────────────────────────────────────────────────

test('(9) trava de imutabilidade: só lead_id pode mudar depois da gravação', async () => {
  await assert.rejects(
    adm.query(`UPDATE lead_manager.origem_lead SET campanha_ref = 'reescrita' WHERE tenant_id = $1`, [T1]),
    /imutável/);
  await assert.rejects(
    adm.query(`UPDATE lead_manager.origem_lead SET metodo = 'manual' WHERE tenant_id = $1`, [T1]),
    /imutável/);
  await assert.rejects(
    adm.query(`UPDATE lead_manager.origem_lead SET payload_bruto = '{}'::jsonb WHERE tenant_id = $1`, [T1]),
    /imutável/);
});

test('(9b) a aplicação nem chega ao gatilho: só tem UPDATE na coluna lead_id', async () => {
  await assert.rejects(
    withTenant(T1, (c) => c.query(`UPDATE origem_lead SET campanha_ref = 'reescrita' WHERE tenant_id = $1`, [T1])),
    /permission denied|permissão negada/i);
});

// ── janela de vigência do de-para ──────────────────────────────────────────────────────

test('(10) de-para vencido não deriva campanha (mas o código é gravado)', async () => {
  const tel = '5519990000010';
  await origemLead.registrarOrigem(T1, msgDe(tel, 'vi o de julho [RK9]'), payload(tel, 'vi o de julho [RK9]'), mudo);
  const [l] = (await linhas(T1)).filter((x) => x.telefone === tel);
  assert.equal(l.codigo_campanha, 'RK9');
  assert.equal(l.metodo, 'codigo_campanha');
  assert.equal(l.campanha_ref, null, 'RK9 valeu só em julho/2026');
});

// ── isolamento por unidade (RLS de verdade: a app conecta como lead_manager_user) ──────

test('(11) RLS: uma unidade não vê a origem da outra', async () => {
  const doT2 = await linhas(T2);
  assert.equal(doT2.length, 0, 'T2 não enxerga nenhuma linha de T1');

  const tel = '5519990000011';
  await origemLead.registrarOrigem(T2, msgDe(tel, 'oi [RK3]'), payload(tel, 'oi [RK3]'), mudo);
  const [l] = await linhas(T2);
  assert.equal(l.campanha_ref, 'DA OUTRA UNIDADE', 'cada unidade lê o próprio de-para');
  assert.equal((await linhas(T1)).some((x) => x.telefone === tel), false);
});

test('(12) o mesmo telefone em duas unidades são duas origens independentes', async () => {
  const tel = '5519990000012';
  const a = await origemLead.registrarOrigem(T1, msgDe(tel, 'oi [RK3]'), payload(tel, 'oi [RK3]'), mudo);
  const b = await origemLead.registrarOrigem(T2, msgDe(tel, 'oi [RK3]'), payload(tel, 'oi [RK3]'), mudo);
  assert.equal(a.gravado, true);
  assert.equal(b.gravado, true, 'o índice único é por (tenant, canal, contato)');
});

// ── LGPD: esquecer a pessoa sem apagar a leitura da mídia ──────────────────────────────

test('(14) anonimização apaga telefone e payload, mantém a atribuição, e libera o contato', async () => {
  const tel = '5519990000014';
  await origemLead.registrarOrigem(T1, msgDe(tel, 'oi [RK3]'), payload(tel, 'oi [RK3]'), mudo);

  // o UPDATE que src/anonymize.js faz — rodando como a aplicação (grants + gatilho valem)
  const anon = 'anonimizado_deadbeefdeadbeef';
  await withTenant(T1, (c) => c.query(
    `UPDATE origem_lead SET telefone = $1, payload_bruto = '{}'::jsonb
      WHERE tenant_id = $2 AND chave_contato = br_phone_key($3) AND telefone NOT LIKE 'anonimizado\\_%'`,
    [anon, T1, tel]));

  const [l] = (await linhas(T1)).filter((x) => x.telefone === anon);
  assert.ok(l, 'a linha continua existindo');
  assert.deepEqual(l.payload_bruto, {});
  assert.equal(l.campanha_ref, 'bateria-set', 'a atribuição não é PII e permanece');
  assert.equal(l.metodo, 'codigo_campanha');

  // esquecida a pessoa, uma mensagem nova é um 1º toque NOVO (a linha antiga saiu do índice)
  const denovo = await origemLead.registrarOrigem(T1, msgDe(tel, 'voltei [RK9]'), payload(tel, 'voltei [RK9]'), mudo);
  assert.equal(denovo.gravado, true);
});

test('(15) anonimizar NÃO é porta de entrada para reescrever a origem', async () => {
  await assert.rejects(
    adm.query(
      `UPDATE lead_manager.origem_lead
          SET telefone = 'anonimizado_0000000000000000', payload_bruto = '{}'::jsonb, campanha_ref = 'outra'
        WHERE tenant_id = $1 AND chave_contato = '1999000004'`, [T1]),
    /imutável/);
  // telefone trocado por OUTRO telefone (não pelo sentinela) também é recusado
  await assert.rejects(
    adm.query(`UPDATE lead_manager.origem_lead SET telefone = '5511999999999' WHERE tenant_id = $1 AND chave_contato = '1999000004'`, [T1]),
    /imutável/);
});

// ── o webhook nunca cai por causa daqui ────────────────────────────────────────────────

test('(13) erro de banco vira log, não exceção', async () => {
  // tenant inexistente: a FK recusa a linha. A função tem de engolir e seguir.
  const r = await origemLead.registrarOrigem('00000000-0000-4000-8000-000000000999',
    msgDe('5519990000099', 'oi'), payload('5519990000099', 'oi'), mudo);
  assert.deepEqual(r, { gravado: false, metodo: null });
  assert.deepEqual(await origemLead.vincularLead('00000000-0000-4000-8000-000000000999', '5519990000099', mudo),
    { vinculado: 0 });
  // sem telefone não há o que gravar (e nada explode)
  assert.deepEqual(await origemLead.registrarOrigem(T1, { externalId: null, body: 'oi' }, {}, mudo),
    { gravado: false, metodo: null });
});

// ── LGPD: depois da exclusão, NENHUMA coluna pode conter dado pessoal ──────────────────
// A varredura é GENÉRICA (to_jsonb da linha inteira), não uma lista de colunas escrita à
// mão: se alguém acrescentar uma coluna com dado pessoal amanhã e esquecer de limpá-la na
// anonimização, este teste fica vermelho sozinho. Uma lista à mão envelheceria em silêncio.
test('(14) exclusão do cliente não deixa telefone, nome nem texto de mensagem em coluna alguma', async () => {
  const tel = '5519990000021';
  const NOME_PERFIL = 'Mariana Fulana de Tal';
  const TEXTO = 'quero matricular meu filho de 9 anos';

  const p = payload(tel, TEXTO, AD('120210000000000001'));
  p.data.pushName = NOME_PERFIL;
  await origemLead.registrarOrigem(T1, msgDe(tel, TEXTO), p, mudo);

  // confere que ANTES da exclusão o dado realmente estava lá (senão o teste passaria à toa)
  const antes = (await adm.query(
    `SELECT to_jsonb(ol) AS linha FROM lead_manager.origem_lead ol
      WHERE tenant_id = $1 AND telefone = $2`, [T1, tel])).rows[0].linha;
  assert.ok(JSON.stringify(antes).includes(NOME_PERFIL), 'cenário inválido: o nome nem foi gravado');
  assert.ok(JSON.stringify(antes).includes(TEXTO), 'cenário inválido: o texto nem foi gravado');

  // A EXCLUSÃO, exatamente como src/anonymize.js faz — e rodando como a APLICAÇÃO,
  // para provar que os grants por coluna permitem apagar e o gatilho não barra.
  const anon = 'anonimizado_cafebabecafebabe';
  await withTenant(T1, (c) => c.query(
    `UPDATE origem_lead
        SET telefone = $1, payload_bruto = '{}'::jsonb,
            anuncio_url = NULL, anuncio_titulo = NULL, anuncio_texto = NULL
      WHERE tenant_id = $2 AND telefone = $3`,
    [anon, T1, tel]));

  // VARREDURA: nenhum valor de nenhuma coluna pode conter o telefone, o nome ou o texto.
  const { rows: vazamentos } = await adm.query(
    `SELECT campo, valor
       FROM lead_manager.origem_lead ol,
            LATERAL jsonb_each_text(to_jsonb(ol)) AS e(campo, valor)
      WHERE ol.tenant_id = $1 AND ol.telefone = $2
        AND (valor ILIKE '%' || $3 || '%'      -- telefone completo
          OR valor ILIKE '%990000021%'          -- telefone sem DDI/DDD
          OR valor ILIKE '%' || $4 || '%'       -- nome do perfil
          OR valor ILIKE '%Mariana%'
          OR valor ILIKE '%' || $5 || '%'       -- texto da mensagem
          OR valor ILIKE '%matricular%')`,
    [T1, anon, tel, NOME_PERFIL, TEXTO]);
  assert.deepEqual(vazamentos, [], `VAZAMENTO após exclusão: ${JSON.stringify(vazamentos)}`);

  // ...e a atribuição sobreviveu inteira: é ela que responde "de qual anúncio veio".
  const dep = (await adm.query(
    `SELECT anuncio_id, codigo_campanha, campanha_ref, motor, objetivo, publico, criativo,
            metodo, capturado_em
       FROM lead_manager.origem_lead WHERE tenant_id = $1 AND telefone = $2`, [T1, anon])).rows[0];
  assert.equal(dep.anuncio_id, '120210000000000001');
  assert.equal(dep.campanha_ref, 'bateria-set');
  assert.equal(dep.metodo, 'anuncio_meta');
  assert.ok(dep.capturado_em);
});

test('(15) a exclusão NÃO é porta para reescrever a atribuição', async () => {
  // apagar o que identifica a pessoa é permitido; mexer na campanha junto, não.
  await assert.rejects(
    adm.query(
      `UPDATE lead_manager.origem_lead
          SET telefone = 'anonimizado_0000111122223333', payload_bruto = '{}'::jsonb,
              anuncio_url = NULL, anuncio_titulo = NULL, anuncio_texto = NULL,
              campanha_ref = 'outra'
        WHERE tenant_id = $1 AND chave_contato = '1999000002'`, [T1]),
    /imutável/);
  // e a aplicação não tem permissão de tocar em campanha nem com a forma certa de exclusão
  await assert.rejects(
    withTenant(T1, (c) => c.query(
      `UPDATE origem_lead SET campanha_ref = 'outra' WHERE tenant_id = $1`, [T1])),
    /permission denied|permissão negada/i);
});
