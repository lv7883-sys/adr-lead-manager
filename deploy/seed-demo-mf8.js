#!/usr/bin/env node
'use strict';
//
// seed-demo-mf8.js — grava o tenant e o cenário de demonstração do Lead Manager (MF8, 04/11/2026).
//
// ─── AS TRÊS CAMADAS DE CONFERÊNCIA, NESTA ORDEM, ANTES DE QUALQUER ESCRITA ──────────────────
//
//   CAMADA 1 — sem banco: o plano contra as restrições CHECK REAIS, lidas de `pg_constraint` e
//              congeladas em test/fixtures/esquema-demo.json. Ver src/demo/conformidade.js.
//   CAMADA 2 — `PREPARE` de cada INSERT contra a tabela real. Valida nome de coluna, aridade e
//              tipo SEM EXECUTAR nada. É a camada que pega o esquema congelado desatualizado.
//   CAMADA 3 — UMA transação só, tudo ou nada. Pega o que só o dado existente revela: chave
//              estrangeira, índice único, gatilho.
//
// A lista de tabelas de todas as três sai do PRÓPRIO PLANO (`tabelasDoPlano`). Não existe segunda
// lista escrita à mão — ver o cabeçalho de src/demo/conformidade.js para o que isso custou em
// 31/10/2026 no dashboard: a sexta de oito tabelas, com 22 testes verdes.
//
// ─── O PORTÃO ────────────────────────────────────────────────────────────────────────────────
//
// Cada INSERT do cenário resolve `tenant_id` por uma SUBCONSULTA que exige `is_demo` (migr 187).
// Em tenant real a subconsulta devolve NULL, a coluna é NOT NULL e a transação inteira cai — o
// modo de falha é gravar NADA, nunca gravar na unidade errada. A verificação em JavaScript que
// vem antes é só o AVISO, para a mensagem ser legível; a trava é a instrução.
//
// ─── USO ─────────────────────────────────────────────────────────────────────────────────────
//
//   # 1. provisionar o tenant (cria a unidade de demonstração no LM e imprime o UUID)
//   node deploy/seed-demo-mf8.js provisionar --slug=clinica-exemplo
//
//   # 2. conferir o cenário sem gravar nada (as 3 camadas rodam; a 3ª faz ROLLBACK)
//   node deploy/seed-demo-mf8.js cenario --tenant=<uuid> --ensaio
//
//   # 3. gravar o cenário
//   node deploy/seed-demo-mf8.js cenario --tenant=<uuid>
//
//   # apagar o cenário (e só o cenário) de um tenant de demonstração
//   node deploy/seed-demo-mf8.js apagar --tenant=<uuid>
//
// `--hoje=YYYY-MM-DD` move a âncora das datas (padrão: hoje em America/Sao_Paulo). Os contratos
// em D-10 e D-2 são relativos a ela: para a apresentação de 04/11, rode com --hoje=2026-11-04 ou
// no próprio dia.
//
const fs = require('node:fs');
const path = require('node:path');
const { pool, withTenant } = require('../src/db');
const cenario = require('../src/demo/cenario-mf8');
const { exigeConformidade } = require('../src/demo/conformidade');
const demo = require('../src/demo/tenant-demo');

const ARQ_ESQUEMA = path.join(__dirname, '..', 'test', 'fixtures', 'esquema-demo.json');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────────────────────
function arg(nome, padrao = null) {
  const p = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return p ? p.slice(nome.length + 3) : padrao;
}
const tem = (nome) => process.argv.includes(`--${nome}`);

/** 'YYYY-MM-DD' de HOJE em America/Sao_Paulo — não no fuso da máquina de quem roda. */
function hojeEmSaoPaulo() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return f.format(new Date());
}

function exigeUuid(v, qual) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''))) {
    throw new Error(`${qual} precisa ser um uuid. Veio ${JSON.stringify(v)}.`);
  }
  return String(v).toLowerCase();
}

/**
 * Monta o INSERT ... ON CONFLICT de um bloco do plano, com o PORTÃO no tenant_id.
 *
 * `$1` é SEMPRE o uuid do tenant. Quando o bloco tem portão (o caso normal), a coluna de tenant
 * NÃO recebe `$1` direto: recebe a subconsulta que exige `is_demo`. Em tenant real ela devolve
 * NULL, a coluna é NOT NULL e a transação inteira cai.
 *
 * `portao: false` existe para a única linha onde a subconsulta não teria o que encontrar: a que
 * CRIA o tenant. Ver o cabeçalho de `planoProvisionamento`.
 */
function sqlDoBloco(bloco) {
  const cols = bloco.colunas;
  const comPortao = bloco.portao !== false;
  const iTenant = cols.indexOf(comPortao ? 'tenant_id' : 'id');
  if (iTenant < 0) {
    throw new Error(
      `seed-demo-mf8: o bloco de ${bloco.tabela} não tem a coluna de tenant esperada `
      + `(${comPortao ? 'tenant_id' : 'id'}) — sem ela não há portão, e sem portão este script não grava.`);
  }
  const valores = [];
  let p = 1;
  cols.forEach((c, k) => {
    if (k === iTenant && comPortao) valores.push(demo.sqlTenantSoSeDemo(1));
    else if (k === iTenant) valores.push('$1');
    else { p += 1; valores.push(`$${p}`); }
  });
  const chave = bloco.chaveConflito;
  const atualiza = cols.filter((c, k) => !chave.includes(c) && k !== iTenant)
    .map((c) => `${c} = EXCLUDED.${c}`);
  const onConflict = atualiza.length
    ? `ON CONFLICT (${chave.join(', ')}) DO UPDATE SET ${atualiza.join(', ')}`
    : `ON CONFLICT (${chave.join(', ')}) DO NOTHING`;
  return {
    sql: `INSERT INTO ${bloco.tabela} (${cols.join(', ')}) VALUES (${valores.join(', ')}) ${onConflict}`,
    // Parâmetros de uma linha: [tenantId, ...valores sem a coluna de tenant]
    paramsDaLinha: (linha) => [null, ...linha.filter((_, k) => k !== iTenant)],
  };
}

/** Lê o esquema congelado, ou explica por que a CAMADA 1 não pode rodar. */
function leEsquemaCongelado() {
  if (!fs.existsSync(ARQ_ESQUEMA)) {
    throw new Error(
      `CAMADA 1 impossível: ${ARQ_ESQUEMA} não existe. Gere-o com\n`
      + '  node deploy/dump-esquema-demo.js\n'
      + 'contra o banco onde o seed vai rodar. Sem o esquema congelado esta camada não confere '
      + 'nada — e o script não vai seguir fingindo que conferiu.');
  }
  return JSON.parse(fs.readFileSync(ARQ_ESQUEMA, 'utf8'));
}

/**
 * As CAMADAS 2 e 3 de um plano qualquer, dentro de UMA transação.
 *
 * Devolve { gravadas, contagens }. Lança com `.ensaio = true` quando `ensaio` está ligado — o
 * que faz `withTenant` desfazer tudo de propósito.
 */
async function aplicaPlano(c, plano, tenantId, { ensaio, rotulo }) {
  const preparados = [];
  let k = 0;
  for (const bloco of plano) {
    if (!bloco.linhas.length) continue;
    const { sql, paramsDaLinha } = sqlDoBloco(bloco);
    k += 1;
    const nome = `seed_demo_${rotulo}_${k}`;
    // CAMADA 2: o banco ANALISA o INSERT contra a tabela REAL — nome de coluna, aridade e tipo —
    // e NÃO executa. Erro aqui é erro de plano, antes de qualquer linha escrita.
    //
    // ⚠ E o statement preparado é SOLTO em seguida, de propósito. A primeira versão tentava
    // executá-lo com `EXECUTE nome ($1, $2, …)`, e o PostgreSQL recusa: no protocolo estendido os
    // `$n` de um EXECUTE não são parâmetros do EXECUTE ("bind message supplies 7 parameters, but
    // prepared statement requires 0"). A camada 3 roda o MESMO texto SQL que a camada 2 analisou
    // — é a mesma instrução, não uma parecida, e é isso que faz a análise valer para a escrita.
    await c.query(`PREPARE ${nome} AS ${sql}`);
    await c.query(`DEALLOCATE ${nome}`);
    preparados.push({ sql, bloco, paramsDaLinha });
  }
  console.log(`CAMADA 2 ok — ${preparados.length} INSERTs analisados pelo banco (PREPARE), nenhum executado`);

  // CAMADA 3: tudo aqui dentro, uma transação só.
  const gravadas = {};
  for (const { sql, bloco, paramsDaLinha } of preparados) {
    for (const linha of bloco.linhas) {
      const params = paramsDaLinha(linha);
      params[0] = tenantId;          // $1 = o parâmetro do portão
      await c.query(sql, params);
      gravadas[bloco.tabela] = (gravadas[bloco.tabela] || 0) + 1;
    }
  }

  // Conferência DENTRO da transação: conta o ESTADO por tabela, não o primeiro sintoma — e antes
  // do COMMIT, para o ensaio poder desfazer.
  for (const tab of [...new Set(plano.map((b) => b.tabela))]) {
    const col = plano.find((b) => b.tabela === tab).portao === false ? 'id' : 'tenant_id';
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${tab} WHERE ${col} = $1`, [tenantId]);
    console.log(`  ${String(rows[0].n).padStart(4)}  ${tab}  (linhas do tenant após a escrita)`);
  }

  if (ensaio) {
    const e = new Error('__ENSAIO__');
    e.ensaio = true;
    throw e;
  }
  return gravadas;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PROVISIONAR — cria o tenant de demonstração no Lead Manager.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// PROVISIONAR — cria o tenant de demonstração no Lead Manager.
//
// Passa pelas MESMAS três camadas do cenário. Na primeira versão deste script ele não passava —
// quatro tabelas gravadas à mão, fora de qualquer conferência. Ver o cabeçalho de
// `tenant-demo.planoProvisionamento` para o que isso tem de parecido com o incidente de
// 31/10/2026 no dashboard.
// ─────────────────────────────────────────────────────────────────────────────────────────────
async function provisionar() {
  const slug = arg('slug');
  if (!slug) throw new Error('provisionar: --slug=<slug-da-unidade> é obrigatório.');
  const hoje = arg('hoje', hojeEmSaoPaulo());
  const ensaio = tem('ensaio') || tem('dry-run');
  const t = demo.tenantDeDemonstracao({ slug });

  // A coluna is_demo existe? Sem ela não há portão — e aí este script não começa.
  const { rows: temCol } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='lead_manager' AND table_name='tenants' AND column_name='is_demo'`);
  if (!temCol.length) {
    throw new Error(
      'provisionar: lead_manager.tenants não tem a coluna is_demo. Aplique a migração '
      + 'db/migrations/187_tenant_demo.sql primeiro — sem ela o portão do cenário não existe '
      + 'e o seed poderia gravar em unidade real.');
  }

  // O uuid é DERIVADO do slug: rodar duas vezes dá o mesmo tenant, e o ON CONFLICT faz o segundo
  // passe atualizar em vez de duplicar. Sorteio aqui faria cada execução criar outra unidade.
  const novoId = cenario.idDe('tenant', slug);

  // Recusa explícita: nome igual já existente que NÃO seja de demonstração. Pode ser unidade real
  // com nome parecido, e marcar is_demo nela a tiraria de telas e laços sem ninguém pedir.
  const homonimo = (await pool.query(
    'SELECT id, is_demo FROM lead_manager.tenants WHERE name = $1 AND id <> $2', [t.name, novoId])).rows[0];
  if (homonimo) {
    throw new Error(
      `provisionar: já existe o tenant ${JSON.stringify(t.name)} com outro id (${homonimo.id}, `
      + `is_demo=${homonimo.is_demo}). Não vou criar um segundo com o mesmo nome.`);
  }

  const p = demo.planoProvisionamento({
    tenantId: novoId, hoje, slug, maisDias: cenario.maisDias, instante: cenario.instante,
  });

  // CAMADA 1 — sem banco, contra as restrições CHECK reais.
  const c1 = exigeConformidade(p, leEsquemaCongelado());
  console.log(`CAMADA 1 ok — ${c1.conferido.linhas} linhas, ${c1.conferido.checks} restrições CHECK avaliadas`);

  // RLS: a policy de `tenants` é `id = current_tenant`, então o contexto da transação tem de ser
  // o uuid do tenant que está NASCENDO. É outra razão para o uuid ser gerado aqui, não no banco.
  const gravadas = await withTenant(novoId, (c) => aplicaPlano(c, p, novoId, { ensaio, rotulo: 'prov' }));

  const total = Object.values(gravadas).reduce((a, b) => a + b, 0);
  console.log(`\nCAMADA 3 ok — ${total} linhas gravadas numa transação só.`);
  console.log('');
  console.log('Tenant de demonstração no Lead Manager:');
  console.log(`  lead_tenant_id      = ${novoId}`);
  console.log(`  name                = ${t.name}`);
  console.log('  is_demo             = true   (portão do seed — migr 187)');
  console.log('  lead_manager_active = false  (fora de TODOS os laços de fundo — tenants_active())');
  console.log('');
  console.log('PRÓXIMO PASSO, E É NO OUTRO REPOSITÓRIO:');
  console.log(`  gravar ${novoId} em app.franquia.lead_tenant_id da unidade de demonstração.`);
  console.log('  Sem isso as telas do dashboard não acham este tenant e mostram o aviso');
  console.log('  "unidade sem tenant do Lead Manager". Esse campo é do adr-whatsapp-scheduler.');
  return novoId;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CENÁRIO — as três camadas, e só então a escrita.
// ─────────────────────────────────────────────────────────────────────────────────────────────
async function gravarCenario() {
  const tenantId = exigeUuid(arg('tenant'), '--tenant');
  const hoje = arg('hoje', hojeEmSaoPaulo());
  const ensaio = tem('ensaio') || tem('dry-run');

  const p = cenario.plano({ tenantId, hoje });
  const r = cenario.resumo({ tenantId, hoje });
  console.log(`Cenário: ${r.linhas} linhas em ${r.tabelas} tabelas (âncora de datas: ${hoje}).`);
  Object.entries(r.porTabela).forEach(([t, n]) => console.log(`  ${String(n).padStart(4)}  ${t}`));

  // CAMADA 1 — sem banco, contra as restrições CHECK reais (esquema congelado).
  const esquema = leEsquemaCongelado();
  const c1 = exigeConformidade(p, esquema);
  console.log(`\nCAMADA 1 ok — ${c1.conferido.linhas} linhas, ${c1.conferido.checks} restrições CHECK avaliadas`);
  console.log(`  (esquema congelado de ${esquema._meta?.banco} em ${esquema._meta?.gerado_em})`);

  // O portão, em JavaScript, só para a MENSAGEM ser legível. A trava é a subconsulta.
  //
  // ⚠ Esta medição é refeita AQUI, imediatamente antes da escrita — não na hora em que alguém
  // pediu autorização. A espera pela permissão é onde o mundo se move: entre o pedido e o
  // comando, outra sessão pode ter ligado o tenant.
  const t = (await pool.query(
    'SELECT id, name, is_demo, lead_manager_active FROM lead_manager.tenants WHERE id = $1',
    [tenantId])).rows[0];
  if (!t) throw new Error(`Nenhum tenant ${tenantId} em lead_manager.tenants.`);
  if (!demo.ehTenantDeDemonstracao(t)) throw new Error(demo.MOTIVO_RECUSA);
  if (t.lead_manager_active) {
    throw new Error(
      `RECUSADO: o tenant ${t.name} tem lead_manager_active = true. Gravar o cenário aqui o `
      + 'colocaria nos laços de fundo (renovação, boas-vindas, silenciosos, waSync) com dados '
      + 'fictícios. Desligue a coluna antes.');
  }
  console.log(`\nPortão ok — ${t.name} (is_demo=true, lead_manager_active=false), medido agora`);

  const gravadas = await withTenant(tenantId, (c) => aplicaPlano(c, p, tenantId, { ensaio, rotulo: 'cen' }));

  const total = Object.values(gravadas).reduce((a, b) => a + b, 0);
  console.log(`\nCAMADA 3 ok — ${total} linhas gravadas numa transação só.`);
  console.log('Cenário no ar para o tenant de demonstração.');
}


// ─────────────────────────────────────────────────────────────────────────────────────────────
// APAGAR — só o cenário, e só de tenant de demonstração.
// ─────────────────────────────────────────────────────────────────────────────────────────────
async function apagar() {
  const tenantId = exigeUuid(arg('tenant'), '--tenant');
  const p = cenario.plano({ tenantId, hoje: hojeEmSaoPaulo() });
  // Ordem INVERSA do plano: as chaves estrangeiras apontam para trás.
  const tabelas = cenario.tabelasDoPlano(p).reverse();
  const contas = {};
  await withTenant(tenantId, async (c) => {
    for (const tab of tabelas) {
      // O PORTÃO também no DELETE: o tenant vem da subconsulta que exige is_demo. Em tenant real
      // `tenant_id = NULL` não casa com nada e o DELETE apaga ZERO linhas.
      const { rowCount } = await c.query(
        `DELETE FROM ${tab} WHERE tenant_id = ${demo.sqlTenantSoSeDemo(1)}`, [tenantId]);
      contas[tab] = rowCount;
    }
  });
  const total = Object.values(contas).reduce((a, b) => a + b, 0);
  Object.entries(contas).forEach(([t, n]) => console.log(`  ${String(n).padStart(5)}  ${t}`));
  console.log(`\n${total} linhas apagadas.`);
  if (total === 0) {
    console.log('ZERO linhas. Isso pode significar duas coisas DIFERENTES, e vale conferir qual:');
    console.log('  (a) o cenário não estava gravado, ou');
    console.log('  (b) o tenant não tem is_demo = true, e o portão recusou tudo em silêncio.');
    const t = (await pool.query('SELECT is_demo FROM lead_manager.tenants WHERE id = $1', [tenantId])).rows[0];
    console.log(`  Medido agora: ${t ? `is_demo = ${t.is_demo}` : 'o tenant não existe'}.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
async function principal() {
  const acao = process.argv[2];
  try {
    if (acao === 'provisionar') await provisionar();
    else if (acao === 'cenario') await gravarCenario();
    else if (acao === 'apagar') await apagar();
    else {
      console.log('Uso: node deploy/seed-demo-mf8.js <provisionar|cenario|apagar> [opções]');
      console.log('  provisionar --slug=<slug>            cria o tenant de demonstração no LM');
      console.log('  cenario --tenant=<uuid> [--ensaio]   confere (3 camadas) e grava o cenário');
      console.log('  apagar  --tenant=<uuid>              apaga só o cenário, só se is_demo');
      console.log('  --hoje=YYYY-MM-DD                    âncora das datas (padrão: hoje em SP)');
      process.exitCode = 64;
    }
  } catch (e) {
    if (e.ensaio) {
      console.log('\nENSAIO: transação desfeita de propósito. Nada foi gravado.');
      console.log('As três camadas passaram — rode sem --ensaio para valer.');
    } else {
      console.error(`\nERRO: ${e.message}`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

principal();
