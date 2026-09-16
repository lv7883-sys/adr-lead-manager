'use strict';
// boas-vindas-recepcao.itest.js — ADR-050 (E17-03/04) em PG DESCARTÁVEL (test/run-boas-vindas-itest.sh).
// Configuração da unidade (modo, variáveis, modelo, texto e ANEXO de cada mensagem) e a fila da recepção
// (listar, enviar com o arquivo, descartar), como lead_manager_user e com um WhatsApp FALSO — nada sai.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-media-'));
process.env.MEDIA_ROOT = MEDIA;   // antes de carregar src/media.js

const { pool, withTenant } = require('../src/db');
const configuracao = require('../src/boasVindas/configuracao');
const recepcao = require('../src/boasVindas/recepcao');

const E = process.env.BV_TENANT_E;   // unidade com régua
const F = process.env.BV_TENANT_F;   // outra unidade (isolamento)
const MODELO = 'escola-de-musica-academia-do-rock';
const PNG = Buffer.from('89504E470D0A1A0A0000000D4948445200000001000000010806000000', 'hex');

let adminPool;
const admin = (sql, p) => adminPool.query(sql, p);
const etapa = (t, ordem) => withTenant(t, async (c) => (await c.query('SELECT * FROM lead_manager.boas_vindas_etapa WHERE ordem = $1', [ordem])).rows[0]);
const codigo = (esperado, trecho) => (e) => {
  assert.equal(e.codigo, esperado, `${e.codigo}: ${JSON.stringify(e.erros)}`);
  if (trecho) assert.ok((e.erros || []).some((m) => m.includes(trecho)), JSON.stringify(e.erros));
  return true;
};

before(async () => {
  const { Pool } = require('pg');
  adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
  // A unidade E tem agenda integrada (sem isso a régua da Academia do Rock, presa às aulas, não liga).
  await admin(`INSERT INTO app.franquia (id, slug, lead_tenant_id) VALUES (2, 'unidade-e', $1) ON CONFLICT DO NOTHING`, [E]);
  await withTenant(E, (c) => c.query(`INSERT INTO lead_manager.automacao_config (tenant_id, nome_ia, contexto_ia) VALUES ($1, 'Janis', 'Escola E')`, [E]));
});
after(async () => { await pool.end(); await adminPool.end(); fs.rmSync(MEDIA, { recursive: true, force: true }); });

// ── Configuração ────────────────────────────────────────────────────────────────────────────────
test('sem régua: a tela mostra os modelos e não deixa ligar', async () => {
  const cfg = await configuracao.obter(E);
  assert.equal(cfg.etapas.length, 0);
  assert.ok(cfg.modelos.some((m) => m.slug === MODELO && m.etapas === 7));
  assert.deepEqual(cfg.modos, ['desligado', 'avisa']);
  await assert.rejects(configuracao.salvarConfig(E, { modo: 'avisa' }), codigo('config_invalida', 'modelo'));
});

test('copiar o modelo cria a régua; copiar de novo não sobrescreve', async () => {
  assert.deepEqual(await configuracao.copiarModelo(E, MODELO, 'gestora'), { ok: true, etapas: 7 });
  await assert.rejects(configuracao.copiarModelo(E, MODELO, 'gestora'), codigo('ja_tem_regua'));
  const cfg = await configuracao.obter(E);
  assert.equal(cfg.config.modelo, MODELO);
  assert.equal(cfg.etapas.length, 7);
});

test('ligar em "avisa" exige a variável {link_ead}; "auto" ainda não existe; resto da automação intacto', async () => {
  await assert.rejects(configuracao.salvarConfig(E, { modo: 'avisa' }), codigo('config_invalida', '{link_ead}'));
  await assert.rejects(configuracao.salvarConfig(E, { modo: 'auto', variaveis: { link_ead: 'https://x' } }), codigo('config_invalida', 'automático'));
  await assert.rejects(configuracao.salvarConfig(E, { variaveis: { cliente: 'x' } }), codigo('config_invalida', 'sistema'));
  await configuracao.salvarConfig(E, { modo: 'avisa', alertaDias: 14, variaveis: { link_ead: 'https://ead.exemplo.com' } });
  const row = (await admin('SELECT nome_ia, contexto_ia, boas_vindas_modo, boas_vindas_alerta_dias, boas_vindas_variaveis FROM lead_manager.automacao_config WHERE tenant_id = $1', [E])).rows[0];
  assert.deepEqual(row, { nome_ia: 'Janis', contexto_ia: 'Escola E', boas_vindas_modo: 'avisa', boas_vindas_alerta_dias: 14, boas_vindas_variaveis: { link_ead: 'https://ead.exemplo.com' } });
});

test('editar mensagem: texto e dias salvam; erro NOVO é recusado; momento preso à aula não se edita', async () => {
  const bv2 = await etapa(E, 2);
  await configuracao.salvarEtapa(E, bv2.id, { texto_titular: 'Orientações da unidade E.', quando_dias: 2 }, 'gestora');
  assert.equal((await etapa(E, 2)).texto_titular, 'Orientações da unidade E.');
  await assert.rejects(configuracao.salvarEtapa(E, bv2.id, { texto_titular: 'Oi {apelido}' }), codigo('regua_invalida', '{apelido}'));
  await assert.rejects(configuracao.salvarEtapa(E, bv2.id, { quando_dias: 1 }), codigo('regua_invalida', 'menos de 2 dias'));
  const lembrete = await etapa(E, 3);
  await assert.rejects(configuracao.salvarEtapa(E, lembrete.id, { quando_dias: 4 }), codigo('quando_fixo'));
});

test('anexo: cada unidade envia o SEU arquivo; formato e tamanho seguem o WhatsApp', async () => {
  const guia = await etapa(E, 5);
  const r = await configuracao.anexar(E, guia.id, { buffer: PNG, mimetype: 'image/png', originalname: 'Guia rápido - Unidade E.png' }, 'gestora');
  assert.equal(r.anexo.tipo, 'imagem');
  assert.match(r.anexo.url, new RegExp(`^/media/${E}/[0-9a-f-]+\\.png$`));
  assert.ok(fs.existsSync(path.join(MEDIA, E, path.basename(r.anexo.url))), 'arquivo gravado no disco da unidade');
  assert.equal((await etapa(E, 5)).anexo_id, r.anexo.id);
  const cfg = await configuracao.obter(E);
  assert.equal(cfg.etapas.find((x) => x.ordem === 5).anexo.nome, 'Guia rápido - Unidade E.png');

  await assert.rejects(configuracao.anexar(E, guia.id, { buffer: Buffer.alloc(10), mimetype: 'video/quicktime', originalname: 'a.mov' }), codigo('anexo_invalido', 'não é aceito'));
  await assert.rejects(configuracao.anexar(E, guia.id, { buffer: Buffer.alloc(6 * 1024 * 1024), mimetype: 'image/png', originalname: 'g.png' }), codigo('anexo_invalido', '5 MB'));
  // outra unidade não enxerga a mensagem da unidade E
  await assert.rejects(configuracao.anexar(F, guia.id, { buffer: PNG, mimetype: 'image/png', originalname: 'x.png' }), (e) => e.status === 404);
});

test('anexo: trocar mantém o histórico; tirar só é permitido se a mensagem tiver texto', async () => {
  const guia = await etapa(E, 5);
  await configuracao.anexar(E, guia.id, { buffer: Buffer.concat([PNG, Buffer.from('v2')]), mimetype: 'image/png', originalname: 'Guia v2.png' }, 'gestora');
  const n = (await admin('SELECT count(*)::int n FROM lead_manager.boas_vindas_anexo WHERE tenant_id = $1', [E])).rows[0].n;
  assert.equal(n, 2);
  const eventos = await etapa(E, 6);
  await configuracao.anexar(E, eventos.id, { buffer: PNG, mimetype: 'image/png', originalname: 'eventos.png' });
  await configuracao.salvarEtapa(E, eventos.id, { texto_titular: '' });
  await assert.rejects(configuracao.removerAnexo(E, eventos.id), codigo('mensagem_vazia'));
  await configuracao.salvarEtapa(E, eventos.id, { texto_titular: 'Conheça nossos eventos!' });
  await configuracao.removerAnexo(E, eventos.id);
  assert.equal((await etapa(E, 6)).anexo_id, null);
});

// ── Fila da recepção ───────────────────────────────────────────────────────────────────────────
let contaId, pessoaId;
async function toque(ordem, { due = '-1 hour', status = 'pendente', bloqueio = null, texto = 'Olá, Pedro!', phone = '5519922220000', rep = 1 } = {}) {
  const et = await etapa(E, ordem);
  return withTenant(E, async (c) => (await c.query(
    `INSERT INTO lead_manager.boas_vindas_toque (tenant_id, account_id, person_id, etapa_id, repeticao, ancora_data, due_at, versao, phone,
       destinatario_nome, cliente_nome, texto_final, status, bloqueio)
     VALUES ($1,$2,$3,$4,$5, current_date, now() + $6::interval, 'responsavel', $7, 'Carla Souza', 'Pedro Souza', $8, $9, $10) RETURNING id`,
    [E, contaId, pessoaId, et.id, rep, due, phone, texto, status, bloqueio])).rows[0].id);
}
function inboxFalso({ falharEm } = {}) {
  const chamadas = [];
  const out = (tipo) => (falharEm === tipo ? { reason: 'instancia=close' } : { ok: true, message_id: `m-${tipo}` });
  return {
    chamadas,
    ensureConversation: async (_c, _t, phone) => { chamadas.push(['ensure', phone]); return { conversation_id: '00000000-0000-4000-8000-00000000c0de', created: true }; },
    sendMessage: async (t, conv, { text }) => { chamadas.push(['texto', conv, text]); return out('texto'); },
    sendInboxMedia: async (t, conv, file, legenda) => { chamadas.push(['arquivo', conv, file.originalname, file.buffer.length, legenda]); return out('arquivo'); },
    sendInboxAudio: async (t, conv, file) => { chamadas.push(['audio', conv, file.originalname]); return out('audio'); },
  };
}

test('fila: só o que já está pronto, com o anexo ATUAL da mensagem e a conversa da família', async () => {
  const w = await withTenant(E, async (c) => {
    const p = (await c.query(`INSERT INTO lead_manager.person (tenant_id, display_name) VALUES ($1, 'Carla Souza') RETURNING id`, [E])).rows[0].id;
    const a = (await c.query(`INSERT INTO lead_manager.service_account (tenant_id, status, ini_vigencia) VALUES ($1, 'ativo', current_date) RETURNING id`, [E])).rows[0].id;
    const cv = (await c.query(`INSERT INTO lead_manager.conversations (tenant_id, channel, external_id, last_activity_at) VALUES ($1, 'whatsapp', '5519922220000', now()) RETURNING id`, [E])).rows[0].id;
    return { p, a, cv };
  });
  pessoaId = w.p; contaId = w.a;
  const pronta = await toque(5, { texto: 'Guia do aluno para vocês.' });
  await toque(2, { due: '+2 days' });   // futura: não entra
  const fila = await recepcao.listarFila(E);
  assert.deepEqual(fila.map((i) => i.id), [pronta]);
  const it = fila[0];
  assert.equal(it.conversationId, w.cv, 'casou pela chave de telefone');
  assert.equal(it.anexo.nome, 'Guia v2.png', 'o arquivo mais recente da mensagem');
  assert.deepEqual(it.envio, ['arquivo'], 'imagem com o texto de legenda');
  assert.equal(it.etapa.nome, 'Guia do Aluno');
  assert.equal((await recepcao.listarFila(F)).length, 0, 'outra unidade não vê');
});

test('enviar: arquivo com legenda pela Caixa de Entrada; marca enviada; não envia duas vezes', async () => {
  const [item] = await recepcao.listarFila(E);
  const fake = inboxFalso();
  const r = await recepcao.enviar(E, item.id, { texto: 'Guia do aluno para vocês! 🎸', sender: 'RECEPCAO' }, { inbox: fake });
  assert.equal(r.ok, true);
  assert.equal(fake.chamadas.length, 1);
  const [tipo, conv, nome, tamanho, legenda] = fake.chamadas[0];
  assert.deepEqual([tipo, conv, nome, legenda], ['arquivo', item.conversationId, 'Guia v2.png', 'Guia do aluno para vocês! 🎸']);
  assert.equal(tamanho, PNG.length + 2);
  const row = (await admin('SELECT status, enviado_em IS NOT NULL AS tem_data, texto_final, anexo_id FROM lead_manager.boas_vindas_toque WHERE id = $1', [item.id])).rows[0];
  assert.deepEqual({ ...row, anexo_id: row.anexo_id === item.anexo.id }, { status: 'enviado', tem_data: true, texto_final: 'Guia do aluno para vocês! 🎸', anexo_id: true });
  assert.equal((await recepcao.enviar(E, item.id, {}, { inbox: fake })).status, 404, 'já saiu da fila');
});

test('enviar sem conversa: cria a conversa; bloqueada sai quando a recepção completa o texto; sem anexo = só texto', async () => {
  const id = await toque(1, { status: 'bloqueado', bloqueio: 'sem_horario', texto: '* Dia:\n* Horário:', phone: '5519955550000' });
  const [item] = (await recepcao.listarFila(E)).filter((i) => i.id === id);
  assert.equal(item.conversationId, null);
  assert.match(item.aviso, /dia e o horário/);
  const fake = inboxFalso();
  const r = await recepcao.enviar(E, id, { texto: '* Dia: quinta-feira, 24/09\n* Horário: 15h', comAnexo: false }, { inbox: fake });
  assert.equal(r.ok, true);
  assert.deepEqual(fake.chamadas.map((c) => c[0]), ['ensure', 'texto']);
  assert.equal((await admin('SELECT status FROM lead_manager.boas_vindas_toque WHERE id = $1', [id])).rows[0].status, 'enviado');
});

test('enviar com WhatsApp desconectado: nada é marcado e a mensagem volta para a fila, do jeito que estava', async () => {
  const id = await toque(4, { status: 'bloqueado', bloqueio: 'sem_profissional', texto: 'Como foi a aula com o professor ?', rep: 1 });
  const r = await recepcao.enviar(E, id, { texto: 'Como foi a primeira aula?' }, { inbox: inboxFalso({ falharEm: 'texto' }) });
  assert.equal(r.erro, 'instancia=close');
  const row = (await admin('SELECT status, bloqueio, erro FROM lead_manager.boas_vindas_toque WHERE id = $1', [id])).rows[0];
  assert.deepEqual(row, { status: 'bloqueado', bloqueio: 'sem_profissional', erro: 'instancia=close' });
});

test('descartar tira da fila; módulo desligado esconde a fila inteira', async () => {
  const id = (await recepcao.listarFila(E))[0].id;
  assert.deepEqual(await recepcao.descartar(E, id, { motivo: 'família já recebeu pessoalmente', por: 'Késsia' }), { ok: true });
  assert.equal((await recepcao.descartar(E, id, {})).status, 409);
  assert.ok(!(await recepcao.listarFila(E)).some((i) => i.id === id));
  await toque(6, { due: '-10 minutes', texto: 'Conheça nossos eventos!' });
  assert.ok((await recepcao.listarFila(E)).length > 0);
  await configuracao.salvarConfig(E, { modo: 'desligado' });
  assert.equal((await recepcao.listarFila(E)).length, 0);
});
