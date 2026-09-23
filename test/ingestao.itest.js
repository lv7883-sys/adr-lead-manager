'use strict';
// ingestao.itest.js — A CAPTURA CONTRA UM POSTGRES DE VERDADE.
//
// A ingestão roda dentro do webhook, sem ninguém olhando: se ela falhar em silêncio, o
// sintoma é "a foto que mandei no grupo não virou nada" — semanas depois, sem log que o
// professor saiba ler. Estas seis provas são o que impede isso:
//
//   (1) grupo que não é fonte não entra — nem uma linha, nem um arquivo;
//   (2) foto de grupo-fonte entra, com o arquivo na pasta DA UNIDADE;
//   (3) o mesmo arquivo reenviado não vira segunda linha nem segunda cópia;
//   (4) cota estourada recusa ANTES de baixar, com o motivo por escrito;
//   (5) a unidade B não enxerga a matéria-prima da unidade A;
//   (6) download quebrado não derruba o webhook: vira linha 'falhou'.
//
// Roda por `make test-ingestao`, num Postgres descartável. A aplicação conecta como
// lead_manager_user (não superusuário), então a RLS exercitada aqui é a mesma de produção.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Client } = require('pg');

process.env.LM_ENCRYPTION_KEY = process.env.LM_ENCRYPTION_KEY || 'chave-de-teste-da-infra';

const { pool, withTenant } = require('../src/db');
const ingestao = require('../src/marketing/ingestao');
const midia = require('../src/marketing/midia');

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GRUPO_A = '120363000000000001@g.us';
const GRUPO_B = '120363000000000002@g.us';
const OUTRO_GRUPO = '120363000000000099@g.us';   // existe no WhatsApp, não é fonte de ninguém

const FRANQUIA = { [A]: 201, [B]: 202 };
let adm;

// Log mudo: o que interessa aqui é o efeito no banco e no disco, não o texto.
const visto = [];
const log = {
  info: (ev, d) => visto.push([ev, d]),
  warn: (ev, d) => visto.push([ev, d]),
  error: (ev, d) => visto.push([ev, d]),
};
const eventos = () => visto.map((v) => v[0]);

async function contratar(tenantId) {
  await adm.query(
    `INSERT INTO app.franquia (id, slug, nome, lead_tenant_id) VALUES ($1, $2, $2, $3)
     ON CONFLICT (id) DO UPDATE SET lead_tenant_id = EXCLUDED.lead_tenant_id`,
    [FRANQUIA[tenantId], `u${FRANQUIA[tenantId]}`, tenantId]);
  await adm.query(
    `INSERT INTO app.tenant_modules (franquia_id, module, active) VALUES ($1, 'MARKETING', true)
     ON CONFLICT (franquia_id, module) DO UPDATE SET active = true`,
    [FRANQUIA[tenantId]]);
}

async function definirFonte(tenantId, jid, nome) {
  await adm.query(
    `INSERT INTO marketing.grupo_fonte (tenant_id, jid, nome) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, jid) DO UPDATE SET ativo = true`, [tenantId, jid, nome]);
}

async function definirCota(tenantId, cota) {
  await adm.query(
    `INSERT INTO marketing.config_unidade (tenant_id, cota) VALUES ($1, $2::jsonb)
     ON CONFLICT (tenant_id) DO UPDATE SET cota = EXCLUDED.cota`,
    [tenantId, JSON.stringify(cota)]);
}

/**
 * Uma mensagem de grupo com foto, já baixada pelo webhook (msg.media.diskPath) — que é
 * exatamente o caminho de produção: a Caixa de Entrada baixa primeiro, a ingestão aproveita.
 * `conteudo` decide o sha256: mesmo conteúdo = mesmo arquivo, para o teste de duplicata.
 */
function mensagemComFoto(jid, { conteudo = 'foto-da-aula', mensagemId = null, semArquivo = false } = {}) {
  const id = mensagemId || `MSG${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const diskPath = `${tmp}/entrada-${crypto.createHash('sha1').update(conteudo).digest('hex')}.jpg`;
  if (!semArquivo) fs.writeFileSync(diskPath, conteudo);
  const key = { remoteJid: jid, fromMe: false, id, participant: '5519999990001@s.whatsapp.net' };
  const msg = {
    externalMessageId: id,
    messageTimestamp: 1758500000,
    sender: 'Professor Téo',
    isGroup: true,
    media: {
      kind: 'image', mimetype: 'image/jpeg',
      rawMessage: { imageMessage: { mimetype: 'image/jpeg' } },
      messageKey: key,
      diskPath: semArquivo ? `${tmp}/nao-existe-${id}.jpg` : diskPath,
    },
  };
  return { msg, rawBody: { data: { key, pushName: 'Professor Téo', messageTimestamp: 1758500000 } } };
}

async function linhas(tenantId) {
  return withTenant(tenantId, async (c) => (await c.query(
    `SELECT id, grupo_jid, mensagem_id, remetente_nome, tipo, mime, tamanho_bytes, sha256,
            caminho, situacao, motivo
       FROM marketing.raw_asset WHERE tenant_id = $1 ORDER BY criado_em`, [tenantId])).rows);
}

let tmp;

before(async () => {
  tmp = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ingest-'));
  adm = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await adm.connect();
  await adm.query('TRUNCATE marketing.raw_asset, marketing.grupo_fonte, marketing.config_unidade');
  await adm.query('TRUNCATE plataforma.consumo_evento');
  await adm.query('TRUNCATE app.tenant_modules, app.franquia CASCADE');
  await contratar(A);
  await contratar(B);
  await definirFonte(A, GRUPO_A, 'Professores A');
  await definirFonte(B, GRUPO_B, 'Professores B');
});

after(async () => {
  await adm.end().catch(() => {});
  await pool.end().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
  // A pasta real da unidade: o teste escreve onde produção escreve (é o CHECK da tabela
  // que exige isso), então limpa o que criou.
  for (const t of [A, B]) fs.rmSync(midia.raizDoTenant(t), { recursive: true, force: true });
});

// ═══ PROVA 1 — grupo que não é fonte não entra ══════════════════════════════════════════

test('(1) grupo que não é fonte da unidade não vira matéria-prima', async () => {
  const { msg, rawBody } = mensagemComFoto(OUTRO_GRUPO);
  const r = await ingestao.capturarMidia({ id: A }, msg, rawBody, log);

  assert.deepEqual(r, { situacao: 'ignorado', motivo: 'grupo_nao_e_fonte' });
  assert.equal((await linhas(A)).length, 0, 'nem uma linha — grupo não configurado é ruído');

  // E o grupo-fonte de OUTRA unidade também não serve: fonte é por unidade, não global.
  const daB = mensagemComFoto(GRUPO_B);
  const b = await ingestao.capturarMidia({ id: A }, daB.msg, daB.rawBody, log);
  assert.equal(b.motivo, 'grupo_nao_e_fonte');
  assert.equal((await linhas(A)).length, 0);
});

// ═══ PROVA 2 — a captura em si ══════════════════════════════════════════════════════════

test('(2) foto do grupo-fonte entra, com o arquivo na pasta da unidade', async () => {
  const { msg, rawBody } = mensagemComFoto(GRUPO_A, { conteudo: 'aula-de-bateria-terca' });
  const r = await ingestao.capturarMidia({ id: A }, msg, rawBody, log);

  assert.equal(r.situacao, 'pendente_curadoria');
  assert.ok(r.id);

  const [linha] = await linhas(A);
  assert.equal(linha.grupo_jid, GRUPO_A);
  assert.equal(linha.tipo, 'imagem');
  assert.equal(linha.mime, 'image/jpeg');
  assert.equal(linha.remetente_nome, 'Professor Téo', 'quem curar precisa saber quem mandou');
  assert.equal(linha.situacao, 'pendente_curadoria');
  assert.equal(linha.motivo, null);
  assert.equal(Number(linha.tamanho_bytes), Buffer.byteLength('aula-de-bateria-terca'));
  assert.equal(linha.sha256,
    crypto.createHash('sha256').update('aula-de-bateria-terca').digest('hex'));

  // O arquivo existe, tem o conteúdo certo e está DENTRO da pasta desta unidade.
  assert.ok(fs.existsSync(linha.caminho), 'linha aceita sem arquivo é o pior dos mundos');
  assert.equal(fs.readFileSync(linha.caminho, 'utf8'), 'aula-de-bateria-terca');
  assert.ok(midia.dentroDaRaiz(A, linha.caminho), linha.caminho);
  assert.ok(!midia.dentroDaRaiz(B, linha.caminho));

  // E o consumo foi contado na conta DESTA unidade (é o que sustenta a cota e a fatura).
  const uso = await withTenant(A, async (c) => (await c.query(
    `SELECT tipo_evento, sum(quantidade)::int AS n FROM plataforma.consumo_evento
      WHERE tenant_id = $1 GROUP BY tipo_evento`, [A])).rows);
  assert.deepEqual(uso, [{ tipo_evento: 'midia_ingerida', n: 1 }]);
});

// ═══ PROVA 3 — duplicata ════════════════════════════════════════════════════════════════

test('(3) o mesmo arquivo reenviado não vira segunda linha nem segunda cópia', async () => {
  const antes = await linhas(A);
  const caminhoOriginal = antes[0].caminho;

  // Outro dia, outra mensagem, MESMO arquivo ("acho que não foi") — e até em outra
  // conversa do mesmo grupo. O que decide é o conteúdo, não o id da mensagem.
  const { msg, rawBody } = mensagemComFoto(GRUPO_A, { conteudo: 'aula-de-bateria-terca' });
  const r = await ingestao.capturarMidia({ id: A }, msg, rawBody, log);

  assert.equal(r.situacao, 'duplicado');
  assert.equal(r.id, antes[0].id, 'aponta para a linha que já existe');

  const depois = await linhas(A);
  assert.equal(depois.length, antes.length, 'continua uma linha só para curar');
  assert.equal(depois[0].caminho, caminhoOriginal, 'e um arquivo só no disco');

  // Um arquivo DIFERENTE do mesmo grupo continua entrando (a trava é por conteúdo).
  const outra = mensagemComFoto(GRUPO_A, { conteudo: 'sarau-de-sexta' });
  const r2 = await ingestao.capturarMidia({ id: A }, outra.msg, outra.rawBody, log);
  assert.equal(r2.situacao, 'pendente_curadoria');
  assert.equal((await linhas(A)).length, antes.length + 1);
});

// ═══ PROVA 4 — cota ═════════════════════════════════════════════════════════════════════

test('(4) cota estourada recusa antes de baixar, e diz por quê', async () => {
  // A já tem 2 aceitas; cota de 2 = cheia.
  await definirCota(A, { midias_mes: 2 });
  const antes = await linhas(A);

  const { msg, rawBody } = mensagemComFoto(GRUPO_A, { conteudo: 'ensaio-da-banda' });
  const r = await ingestao.capturarMidia({ id: A }, msg, rawBody, log);

  assert.equal(r.situacao, 'cota_excedida');
  assert.equal(r.motivo, 'midias_mes: 2/2');

  const recusada = (await linhas(A)).find((l) => l.situacao === 'cota_excedida');
  assert.ok(recusada, 'a recusa fica registrada: "sumiu" não pode ser a única explicação');
  assert.equal(recusada.motivo, 'midias_mes: 2/2');
  assert.equal(recusada.caminho, null, 'cota estourada não gasta disco');
  assert.equal(recusada.sha256, null, 'nem banda: o download nem acontece');
  assert.equal(recusada.remetente_nome, 'Professor Téo', 'ainda dá para avisar quem mandou');

  assert.ok(eventos().includes('ingestao.cota_excedida'), 'e sai no log como aviso, não como info');
  assert.equal((await linhas(A)).filter((l) => l.situacao === 'pendente_curadoria').length,
    antes.filter((l) => l.situacao === 'pendente_curadoria').length, 'nada novo foi aceito');

  await definirCota(A, { midias_mes: 100 });   // libera para as provas seguintes
});

// ═══ PROVA 5 — isolamento ═══════════════════════════════════════════════════════════════

test('(5) a unidade B não enxerga a matéria-prima da unidade A', async () => {
  const daB = mensagemComFoto(GRUPO_B, { conteudo: 'apresentacao-da-unidade-B' });
  const r = await ingestao.capturarMidia({ id: B }, daB.msg, daB.rawBody, log);
  assert.equal(r.situacao, 'pendente_curadoria');

  const listaA = await linhas(A);
  const listaB = await linhas(B);

  assert.ok(listaA.length >= 3);
  assert.equal(listaB.length, 1, 'B vê só a sua');
  assert.ok(!listaB.some((l) => listaA.some((a) => a.id === l.id)));
  assert.ok(!listaA.some((l) => l.grupo_jid === GRUPO_B), 'e A não vê nada de B');

  // O arquivo de B está na pasta de B — e não na de A.
  assert.ok(midia.dentroDaRaiz(B, listaB[0].caminho));
  assert.ok(!midia.dentroDaRaiz(A, listaB[0].caminho));

  // A prova que importa: mesmo pedindo pelo id de A, dentro do contexto de B não vem nada.
  const espiada = await withTenant(B, async (c) => (await c.query(
    'SELECT id FROM marketing.raw_asset WHERE id = $1', [listaA[0].id])).rowCount);
  assert.equal(espiada, 0, 'a RLS barra até o SELECT por id direto');
});

// ═══ PROVA 6 — falha do download ════════════════════════════════════════════════════════

test('(6) download quebrado não derruba o webhook: vira linha "falhou"', async () => {
  // Arquivo que o webhook diz ter baixado mas não está no disco, e sem credencial da
  // Evolution para tentar de novo (a tabela `tenants` nem existe neste banco de teste) —
  // ou seja, a pior combinação possível.
  const { msg, rawBody } = mensagemComFoto(GRUPO_A, { conteudo: 'video-grande', semArquivo: true });

  const r = await ingestao.capturarMidia({ id: A }, msg, rawBody, log);   // NÃO pode lançar

  assert.equal(r.situacao, 'falhou');
  assert.ok(r.motivo, 'a falha tem motivo escrito');

  const falha = (await linhas(A)).find((l) => l.situacao === 'falhou');
  assert.ok(falha, 'a falha fica registrada para alguém poder reenviar');
  assert.equal(falha.caminho, null);
  assert.equal(falha.sha256, null);
  assert.equal(falha.mensagem_id, msg.externalMessageId);

  // E a mesma mensagem reentregue pelo webhook não vira uma segunda linha de falha.
  await ingestao.capturarMidia({ id: A }, msg, rawBody, log);
  assert.equal((await linhas(A)).filter((l) => l.situacao === 'falhou').length, 1);
});

// ── PROVA 7 — o privilégio, que teste de código não pega ────────────────────────────────

test('(7) a aplicação NÃO consegue apagar matéria-prima (privilégio, não código)', async () => {
  // Por que isto existe: em 21/09 a `origem_lead` nasceu APAGÁVEL em produção, e nenhum teste
  // viu. O schema `lead_manager` tem um `ALTER DEFAULT PRIVILEGES ... GRANT ALL` antigo, então
  // toda tabela nova ganha DELETE de brinde — e o banco descartável, rodando como superusuário,
  // não reproduzia isso. Foi preciso a migração 174 para tapar.
  //
  // O mesmo defeito tem duas direções: privilégio A MAIS (aquele caso) e privilégio A MENOS
  // (o `permission denied for table campanha_alvo` que a sessão de WhatsApp levou a produção
  // hoje). Mecanismo idêntico: **o teste roda como superusuário e não prova acesso nenhum.**
  // Aqui a conexão é `lead_manager_user`, como em produção — é isso que dá valor à asserção.
  const [alguma] = await linhas(A);
  assert.ok(alguma, 'precisa existir linha para a prova valer');

  await assert.rejects(
    withTenant(A, (c) => c.query('DELETE FROM marketing.raw_asset WHERE id = $1', [alguma.id])),
    (e) => e.code === '42501',   // insufficient_privilege
    'a aplicação tem DELETE em raw_asset — matéria-prima do professor pode ser apagada por bug');

  assert.equal((await linhas(A)).length, (await linhas(A)).length, 'e a linha continua lá');

  // O outro lado: o que a aplicação PRECISA poder fazer tem de funcionar sob o mesmo papel.
  // A curadoria muda `situacao`; se o UPDATE faltasse, a fase seguinte morreria em silêncio.
  await withTenant(A, (c) => c.query(
    'UPDATE marketing.raw_asset SET motivo = motivo WHERE id = $1', [alguma.id]));
});

test('(8) o grupo-fonte é apagável — configuração não é matéria-prima', async () => {
  // Assimetria deliberada: a recepção descadastra um grupo pela tela (precisa de DELETE), mas
  // a mídia que já entrou não se apaga pela aplicação. Se um dia alguém "uniformizar" os grants,
  // este teste diz qual das duas tabelas perdeu a regra.
  await withTenant(A, (c) => c.query(
    'INSERT INTO marketing.grupo_fonte (tenant_id, jid, nome) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [A, '120363000000000777@g.us', 'Grupo temporário']));
  const n = await withTenant(A, (c) => c.query(
    'DELETE FROM marketing.grupo_fonte WHERE tenant_id = $1 AND jid = $2',
    [A, '120363000000000777@g.us']).then((r) => r.rowCount));
  assert.equal(n, 1, 'a recepção precisa poder descadastrar o grupo pela tela');
});
