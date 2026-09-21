'use strict';
// isolamento-tenant.itest.js — SUÍTE BLOQUEANTE. Se qualquer teste daqui falhar, o build cai.
//
// Um módulo vendido a unidades diferentes (e, depois, a empresas diferentes) só pode ir para
// produção com estas quatro provas de pé:
//   (1) a unidade A não lê NENHUMA linha de marketing da unidade B;
//   (2) a credencial de A nunca é resolvida dentro de um trabalho de B;
//   (3) a cota de A não consome a cota de B;
//   (4) o trabalhador atendendo A não segura a fila de B.
//
// Roda por `make test-isolation` (ou pelo bloco equivalente), num Postgres descartável.
// A aplicação conecta como lead_manager_user (não superusuário): a RLS exercitada aqui é a
// MESMA de produção — como superusuário, o teste não provaria nada.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

process.env.LM_ENCRYPTION_KEY = process.env.LM_ENCRYPTION_KEY || 'chave-de-teste-da-infra';
process.env.PLATAFORMA_CREDENCIAL_TTL_MS = '50';   // TTL curto p/ o teste de cache não mascarar leitura

const { pool, withTenant } = require('../src/db');
const licenca = require('../src/plataforma/licenca');
const credenciais = require('../src/plataforma/credenciais');
const consumo = require('../src/plataforma/consumo');
const fila = require('../src/marketing/fila');
const midia = require('../src/marketing/midia');

const A = process.env.ISO_TENANT_A || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = process.env.ISO_TENANT_B || 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';   // unidade SEM o módulo contratado

let adm;

// CONTRATAÇÃO — mora em app.tenant_modules (fonte única de hoje; amanhã, plataforma.assinatura).
// O teste semeia pela ponte real: app.franquia.lead_tenant_id -> uuid da unidade.
const FRANQUIA = { [A]: 101, [B]: 102, [C]: 103 };
async function contratar(tenantId, ativo = true) {
  await adm.query(
    `INSERT INTO app.franquia (id, slug, nome, lead_tenant_id) VALUES ($1, $2, $2, $3)
     ON CONFLICT (id) DO UPDATE SET lead_tenant_id = EXCLUDED.lead_tenant_id`,
    [FRANQUIA[tenantId], `u${FRANQUIA[tenantId]}`, tenantId]);
  await adm.query(
    `INSERT INTO app.tenant_modules (franquia_id, module, active) VALUES ($1, 'MARKETING', $2)
     ON CONFLICT (franquia_id, module) DO UPDATE SET active = EXCLUDED.active`,
    [FRANQUIA[tenantId], ativo]);
}

// COTA — limite de uso do motor, separado da contratação (marketing.config_unidade.cota).
async function definirCota(tenantId, cota) {
  await adm.query(
    `INSERT INTO marketing.config_unidade (tenant_id, cota) VALUES ($1, $2::jsonb)
     ON CONFLICT (tenant_id) DO UPDATE SET cota = EXCLUDED.cota`,
    [tenantId, JSON.stringify(cota)]);
}

before(async () => {
  adm = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await adm.connect();
  await adm.query('TRUNCATE marketing.tarefa, marketing.arquivo, marketing.config_unidade');
  await adm.query('TRUNCATE plataforma.consumo_evento, plataforma.credencial_unidade');
  await adm.query('TRUNCATE app.tenant_modules, app.franquia CASCADE');
  await contratar(A);
  await contratar(B);
  // C existe como franquia, mas SEM o módulo contratado
  await adm.query(
    `INSERT INTO app.franquia (id, slug, nome, lead_tenant_id) VALUES ($1, 'u103', 'u103', $2)
     ON CONFLICT (id) DO UPDATE SET lead_tenant_id = EXCLUDED.lead_tenant_id`,
    [FRANQUIA[C], C]);
});

after(async () => {
  await adm.end().catch(() => {});
  await pool.end().catch(() => {});
});

// ═══ PROVA 1 — A não lê nada de B ══════════════════════════════════════════════════════

test('(1) nenhuma linha de marketing de B aparece para A', async () => {
  // cada unidade cria as suas: identidade visual, mídia e trabalho na fila
  for (const [t, marca] of [[A, 'ESCOLA-A'], [B, 'ESCOLA-B']]) {
    await withTenant(t, (c) => c.query(
      `INSERT INTO marketing.config_unidade (tenant_id, nome_exibicao, cor_primaria) VALUES ($1, $2, '#112233')`,
      [t, marca]));
    await withTenant(t, (c) => c.query(
      `INSERT INTO marketing.arquivo (tenant_id, tipo, caminho) VALUES ($1, 'imagem', $2)`,
      [t, midia.caminhoMidia(t, `${marca}.png`)]));
    await credenciais.gravarCredencial(t, 'gemini', 'chave_api', `CHAVE-${marca}`);
    await fila.enfileirar(t, 'render_imagem', { marca });
  }

  for (const [eu, outro] of [[A, B], [B, A]]) {
    const visto = await withTenant(eu, async (c) => ({
      config: (await c.query('SELECT tenant_id, nome_exibicao FROM marketing.config_unidade')).rows,
      midia: (await c.query('SELECT tenant_id, caminho FROM marketing.arquivo')).rows,
      tarefas: (await c.query('SELECT tenant_id, dados FROM marketing.tarefa')).rows,
      credenciais: (await c.query('SELECT tenant_id FROM plataforma.credencial_unidade')).rows,
    }));
    for (const [tabela, linhas] of Object.entries(visto)) {
      assert.ok(linhas.length > 0, `${tabela}: ${eu} deveria ver as próprias linhas`);
      for (const l of linhas) {
        assert.equal(l.tenant_id, eu, `VAZAMENTO em ${tabela}: ${eu} enxergou linha de ${l.tenant_id}`);
      }
    }
    // e nada do outro escapa por busca direta pelo id
    const porId = await withTenant(eu, async (c) => (await c.query(
      'SELECT count(*)::int AS n FROM marketing.tarefa WHERE tenant_id = $1', [outro])).rows[0].n);
    assert.equal(porId, 0, `${eu} conseguiu contar tarefas de ${outro}`);
  }
});

test('(1b) A não consegue nem GRAVAR uma linha no nome de B', async () => {
  await assert.rejects(
    withTenant(A, (c) => c.query(
      `INSERT INTO marketing.tarefa (tenant_id, tipo) VALUES ($1, 'invasao')`, [B])),
    /row-level security|violates row-level/i,
    'a policy WITH CHECK tem de barrar escrita em nome de outra unidade');
  const tarefasDeB = await withTenant(B, async (c) => (await c.query(
    `SELECT count(*)::int AS n FROM marketing.tarefa WHERE tipo = 'invasao'`)).rows[0].n);
  assert.equal(tarefasDeB, 0);
});

test('(1c) o caminho de mídia de uma unidade nunca cabe na pasta da outra', async () => {
  await assert.rejects(
    withTenant(A, (c) => c.query(
      `INSERT INTO marketing.arquivo (tenant_id, tipo, caminho) VALUES ($1, 'imagem', $2)`,
      [A, `/srv/adr-media/${B}/roubado.png`])),
    /arquivo_caminho_da_unidade_chk|violates check/i,
    'o CHECK do banco tem de recusar caminho fora da raiz da unidade');
});

// ═══ PROVA 2 — credencial de A nunca aparece num trabalho de B ═════════════════════════

test('(2) cada unidade resolve a SUA credencial, e só a dela', async () => {
  await credenciais.gravarCredencial(A, 'gemini', 'chave_api', 'CHAVE-DA-UNIDADE-A');
  await credenciais.gravarCredencial(B, 'gemini', 'chave_api', 'CHAVE-DA-UNIDADE-B');

  // ordem de propósito: A primeiro, B logo depois — se o cache ignorasse o tenant,
  // B receberia a chave de A aqui.
  assert.equal(await credenciais.lerCredencial(A, 'gemini', 'chave_api'), 'CHAVE-DA-UNIDADE-A');
  assert.equal(await credenciais.lerCredencial(B, 'gemini', 'chave_api'), 'CHAVE-DA-UNIDADE-B');
  assert.equal(await credenciais.lerCredencial(A, 'gemini', 'chave_api'), 'CHAVE-DA-UNIDADE-A');

  // unidade sem credencial cadastrada não herda a de ninguém
  assert.equal(await credenciais.lerCredencial(C, 'gemini', 'chave_api'), null);
  // provedor/tipo inexistentes também não caem em fallback
  assert.equal(await credenciais.lerCredencial(A, 'meta', 'token_acesso'), null);
});

test('(2b) dentro do contexto de B, a credencial de A não existe — nem cifrada', async () => {
  const visto = await withTenant(B, async (c) => (await c.query(
    'SELECT tenant_id, provedor FROM plataforma.credencial_unidade')).rows);
  assert.ok(visto.length > 0);
  for (const l of visto) assert.equal(l.tenant_id, B, `VAZAMENTO de credencial: ${B} viu linha de ${l.tenant_id}`);

  const deA = await withTenant(B, async (c) => (await c.query(
    'SELECT count(*)::int AS n FROM plataforma.credencial_unidade WHERE tenant_id = $1', [A])).rows[0].n);
  assert.equal(deA, 0);
});

test('(2c) a credencial não fica em claro no banco', async () => {
  const bruto = await adm.query('SELECT valor_cifrado FROM plataforma.credencial_unidade');
  assert.ok(bruto.rows.length >= 2);
  for (const l of bruto.rows) {
    const texto = l.valor_cifrado.toString('utf8');
    assert.ok(!texto.includes('CHAVE-DA-UNIDADE'), 'credencial gravada em texto legível');
  }
});

test('(2c2) revogar apaga o segredo e para de resolver na hora', async () => {
  await credenciais.gravarCredencial(A, 'meta', 'token_acesso', 'TOKEN-TEMPORARIO',
    { metadados: { conta: 'pagina-A' } });
  assert.equal(await credenciais.lerCredencial(A, 'meta', 'token_acesso'), 'TOKEN-TEMPORARIO');

  assert.equal(await credenciais.revogarCredencial(A, 'meta', 'token_acesso'), 1);
  assert.equal(await credenciais.lerCredencial(A, 'meta', 'token_acesso'), null, 'revogada não resolve');
  assert.equal(await credenciais.revogarCredencial(A, 'meta', 'token_acesso'), 0, 'revogar de novo é no-op');

  // o segredo saiu do banco; a trilha e os metadados ficaram
  const linha = (await adm.query(
    `SELECT valor_cifrado, revogado_em, metadados FROM plataforma.credencial_unidade
      WHERE tenant_id = $1 AND provedor = 'meta'`, [A])).rows[0];
  assert.equal(linha.valor_cifrado, null, 'o segredo revogado continuou gravado');
  assert.ok(linha.revogado_em);
  assert.equal(linha.metadados.conta, 'pagina-A', 'os metadados de quem era a conta se perderam');
  // apagar daqui NÃO encerra a exposição (o backup de ontem ainda tem o segredo):
  // sem revogação na origem, a credencial entra na lista de pendências.
  assert.equal(linha.metadados.revogado_na_origem, 'nao');
  const pendentes = await credenciais.pendentesNaOrigem(A);
  assert.equal(pendentes.length, 1);
  assert.equal(pendentes[0].provedor, 'meta');

  // gravar de novo devolve a credencial ao ar (e limpa a revogação e a pendência)
  await credenciais.gravarCredencial(A, 'meta', 'token_acesso', 'TOKEN-NOVO');
  assert.equal(await credenciais.lerCredencial(A, 'meta', 'token_acesso'), 'TOKEN-NOVO');
  assert.equal((await credenciais.pendentesNaOrigem(A)).length, 0);

  // revogada COM giro na origem sai da lista de pendências: o que está no backup virou inútil
  await credenciais.revogarCredencial(A, 'meta', 'token_acesso', { naOrigem: 'sim' });
  assert.equal((await credenciais.pendentesNaOrigem(A)).length, 0);
  const comGiro = await credenciais.metadadosCredencial(A, 'meta', 'token_acesso');
  assert.equal(comGiro.metadados.revogado_na_origem, 'sim');
  assert.ok(comGiro.metadados.revogado_na_origem_em, 'registra QUANDO girou na origem');
});

test('(2d) a unidade sem o módulo não entra na fila nem gasta nada', async () => {
  await assert.rejects(() => fila.enfileirar(C, 'render_imagem', {}), /sem acesso a MARKETING/);
  assert.equal(await licenca.moduloAtivo(C, 'MARKETING'), false);
  assert.equal(await licenca.moduloAtivo(A, 'MARKETING'), true);
});

// ═══ PROVA 3 — cota de A não consome cota de B ═════════════════════════════════════════

test('(3) o consumo de uma unidade não entra na conta da outra', async () => {
  await consumo.registrarUso(A, 'MARKETING', consumo.TIPOS.IA_VISAO, 7);
  await consumo.registrarUso(A, 'MARKETING', consumo.TIPOS.IA_TEXTO, 3);
  await consumo.registrarUso(B, 'MARKETING', consumo.TIPOS.IA_VISAO, 1);

  const usoA = await consumo.consumoDoMes(A, 'MARKETING');
  const usoB = await consumo.consumoDoMes(B, 'MARKETING');
  assert.equal(usoA[consumo.TIPOS.IA_VISAO], 7);
  assert.equal(usoA[consumo.TIPOS.IA_TEXTO], 3);
  assert.equal(usoB[consumo.TIPOS.IA_VISAO], 1);
  assert.equal(usoB[consumo.TIPOS.IA_TEXTO], undefined, 'o consumo de A apareceu na conta de B');

  // a view de custo enxerga só a própria unidade
  const custoB = await consumo.custoPorMes(B);
  assert.ok(custoB.length > 0);
  const totalB = custoB.reduce((s, l) => s + Number(l.quantidade), 0);
  assert.equal(totalB, 1, 'a view de custo de B somou consumo de A');
});

test('(3b) A estourar a cota não impede B de trabalhar', async () => {
  await adm.query('TRUNCATE marketing.tarefa');
  await definirCota(A, { tarefas_mes: 1 });   // plano apertado
  await definirCota(B, { tarefas_mes: 50 });
  // A já gastou o mês: uma tarefa atendida hoje
  await adm.query(
    `INSERT INTO marketing.tarefa (tenant_id, tipo, situacao, pega_em, concluido_em)
     VALUES ($1, 'render_imagem', 'concluida', now(), now())`, [A]);
  await fila.enfileirar(A, 'render_imagem', { n: 1 });
  await fila.enfileirar(A, 'render_imagem', { n: 2 });
  await fila.enfileirar(B, 'render_imagem', { n: 1 });

  // B nunca foi atendida, então o rodízio a coloca na frente de A (que acabou de ser)
  const primeiro = await fila.pegarTarefa({ trabalhador: 'w-teste' });
  assert.ok(primeiro, 'o trabalhador tinha de conseguir trabalho');
  assert.equal(primeiro.tenant_id, B, 'a cota estourada de A não pode parar a fila de B');

  // a rodada seguinte chega em A, vê a cota estourada e não trava o worker
  const segundo = await fila.pegarTarefa({ trabalhador: 'w-teste' });
  assert.equal(segundo, null, 'só havia trabalho barrado por cota — o trabalhador devolve vazio, não trava');

  // e as tarefas de A não sumiram em silêncio: viraram cota_excedida com o motivo escrito
  const deA = await withTenant(A, async (c) => (await c.query(
    `SELECT situacao, motivo_cota FROM marketing.tarefa WHERE situacao <> 'concluida' ORDER BY criado_em`)).rows);
  assert.equal(deA.length, 2);
  for (const l of deA) {
    assert.equal(l.situacao, 'cota_excedida');
    assert.match(l.motivo_cota, /tarefas_mes: \d+\/1/);
  }
  await definirCota(A, {});   // devolve o plano para os testes seguintes
});

// ═══ PROVA 4 — trabalhador em A não bloqueia B ══════════════════════════════════════════════

test('(4) tarefa travado de uma unidade não segura o worker da outra (SKIP LOCKED)', async () => {
  await adm.query('TRUNCATE marketing.tarefa');
  const tarefaA = await fila.enfileirar(A, 'render_imagem', { lento: true });
  await fila.enfileirar(B, 'render_imagem', { rapido: true });

  // segura a tarefa de A numa transação aberta, como um worker que está demorando
  const travador = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await travador.connect();
  await travador.query('BEGIN');
  await travador.query('SELECT id FROM marketing.tarefa WHERE id = $1 FOR UPDATE', [tarefaA.id]);

  try {
    const inicio = Date.now();
    const tarefa = await fila.pegarTarefa({ trabalhador: 'w-2' });
    const decorrido = Date.now() - inicio;
    assert.ok(tarefa, 'o trabalhador ficou sem trabalho por causa da tarefa travada da outra unidade');
    assert.equal(tarefa.tenant_id, B, 'deveria ter pulado a tarefa travada de A e atendido B');
    assert.ok(decorrido < 5000, `o trabalhador esperou ${decorrido}ms — SKIP LOCKED não está valendo`);
  } finally {
    await travador.query('ROLLBACK').catch(() => {});
    await travador.end().catch(() => {});
  }
});

test('(4b) o rodízio alterna entre as unidades em vez de esvaziar uma primeiro', async () => {
  await adm.query('TRUNCATE marketing.tarefa');
  for (let i = 0; i < 3; i++) {
    await fila.enfileirar(A, 'render_imagem', { i });
    await fila.enfileirar(B, 'render_imagem', { i });
  }
  const ordem = [];
  for (let i = 0; i < 6; i++) {
    const tarefa = await fila.pegarTarefa({ trabalhador: 'w-rodizio' });
    assert.ok(tarefa, `faltou trabalho na rodada ${i}`);
    ordem.push(tarefa.tenant_id === A ? 'A' : 'B');
    await fila.concluir(tarefa.tenant_id, tarefa.id);
  }
  // nunca três seguidas da mesma unidade
  for (let i = 0; i + 2 < ordem.length; i++) {
    assert.ok(!(ordem[i] === ordem[i + 1] && ordem[i + 1] === ordem[i + 2]),
      `uma unidade monopolizou o trabalhador: ${ordem.join('')}`);
  }
  assert.equal(ordem.filter((x) => x === 'A').length, 3);
  assert.equal(ordem.filter((x) => x === 'B').length, 3);
});

test('(4c) a pergunta "quem está na fila?" devolve id e contagem, nunca conteúdo', async () => {
  await adm.query('TRUNCATE marketing.tarefa');
  await fila.enfileirar(A, 'render_imagem', { segredo: 'plano de A' });
  const linhas = await fila.unidadesNaFila();
  assert.equal(linhas.length, 1);
  assert.deepEqual(Object.keys(linhas[0]).sort(), ['pendentes', 'tenant_id', 'ultima_vez']);
  assert.equal(linhas[0].tenant_id, A);
  assert.equal(JSON.stringify(linhas).includes('segredo'), false);
});
