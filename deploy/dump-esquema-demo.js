#!/usr/bin/env node
'use strict';
//
// dump-esquema-demo.js — congela o ESQUEMA REAL das tabelas que o seed de demonstração escreve.
//
// READ-ONLY. Não escreve uma linha no banco. Lê `information_schema.columns` e `pg_constraint`
// e grava `test/fixtures/esquema-demo.json`, que é o insumo da CAMADA 1 da conferência.
//
// POR QUE O DUMP VEM DO BANCO, E NÃO DAS MIGRAÇÕES
//
// Porque o arquivo de migração MENTE sobre o estado atual. A 092 criou
//
//     CHECK (marco IN ('D-10','D-2'))
//
// e a 109 a substituiu por seis valores. Quem conferir pelo arquivo que criou a tabela acha que
// 'D-45' é inválido. E há o inverso: migrações que o repositório tem e produção NÃO aplicou —
// a própria RESERVAS.md lista 131, 132–139, 140–169, 185 e 186 como não aplicadas. Então nem
// "replicar todas as migrações num banco vazio" produz o esquema de produção. Só produção produz
// o esquema de produção.
//
// ⚠ POR ISSO O ARQUIVO GERADO DIZ DE ONDE VEIO E QUANDO. Um esquema congelado sem procedência é
//   uma afirmação sobre produção sem fonte nem data — exatamente o que este projeto não aceita.
//
// A LISTA DE TABELAS SAI DO PLANO, NUNCA DE UMA SEGUNDA LISTA
//
// `tabelasDoPlano(plano(...))`. Se amanhã o cenário passar a escrever numa décima primeira
// tabela, o dump a inclui sozinho — e, se ninguém refizer o dump, a camada 1 ACUSA a tabela
// faltando em vez de deixá-la sem conferência (foi esse o defeito de 31/10/2026 no dashboard).
//
// USO (na VPS, no container do LM, ou de qualquer lugar com DATABASE_URL para o banco alvo):
//   node deploy/dump-esquema-demo.js                       # grava test/fixtures/esquema-demo.json
//   node deploy/dump-esquema-demo.js --saida=/tmp/x.json   # grava em outro lugar
//
const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../src/db');
const { plano, tabelasDoPlano } = require('../src/demo/cenario-mf8');

// tenant/hoje fictícios: o plano só é usado aqui para DERIVAR a lista de tabelas; nenhum valor
// dele é gravado nem lido. Qualquer uuid e qualquer data servem — e precisam ser constantes,
// senão o dump muda de conteúdo sem o esquema ter mudado.
const TENANT_FICTICIO = '00000000-0000-0000-0000-000000000000';
const DATA_FICTICIA = '2026-01-01';

const SQL_COLUNAS = `
  SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.udt_name,
         c.is_nullable, c.column_default, c.is_generated, c.generation_expression,
         c.character_maximum_length
    FROM information_schema.columns c
   WHERE (c.table_schema || '.' || c.table_name) = ANY($1::text[])
   ORDER BY c.table_schema, c.table_name, c.ordinal_position`;

// Só CHECK (contype='c'). NOT NULL mora em pg_attribute e já vem por information_schema acima.
// NOT VALID entra também, com a marca: restrição não validada vale para linha NOVA — e o seed
// grava linha nova.
const SQL_CHECKS = `
  SELECT n.nspname || '.' || t.relname AS tabela, con.conname, con.convalidated,
         pg_get_constraintdef(con.oid) AS definicao
    FROM pg_constraint con
    JOIN pg_class t ON t.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE con.contype = 'c'
     AND (n.nspname || '.' || t.relname) = ANY($1::text[])
   ORDER BY 1, 2`;

async function principal() {
  const saidaArg = process.argv.find((a) => a.startsWith('--saida='));
  const saida = saidaArg
    ? saidaArg.slice('--saida='.length)
    : path.join(__dirname, '..', 'test', 'fixtures', 'esquema-demo.json');

  const tabelas = tabelasDoPlano(plano({ tenantId: TENANT_FICTICIO, hoje: DATA_FICTICIA }));
  console.log(`Tabelas derivadas do plano: ${tabelas.length}`);
  tabelas.forEach((t) => console.log(`  • ${t}`));

  const [colunas, checks, ondeEstou] = await Promise.all([
    pool.query(SQL_COLUNAS, [tabelas]),
    pool.query(SQL_CHECKS, [tabelas]),
    pool.query('SELECT current_database() AS db, inet_server_port() AS porta, version() AS versao'),
  ]);

  const fora = { tabelas: {} };
  for (const r of colunas.rows) {
    const nome = `${r.table_schema}.${r.table_name}`;
    fora.tabelas[nome] = fora.tabelas[nome] || { colunas: {}, checks: [] };
    fora.tabelas[nome].colunas[r.column_name] = {
      tipo: r.data_type,
      udt: r.udt_name,
      nulo: r.is_nullable === 'YES',
      temDefault: r.column_default !== null,
      default: r.column_default,
      gerada: r.is_generated === 'ALWAYS',
      tamanhoMax: r.character_maximum_length,
    };
  }
  for (const r of checks.rows) {
    if (!fora.tabelas[r.tabela]) continue;   // tabela sem colunas lidas = não existe; já acusada
    fora.tabelas[r.tabela].checks.push(r.definicao);
    if (!r.convalidated) {
      fora.tabelas[r.tabela].naoValidadas = (fora.tabelas[r.tabela].naoValidadas || []).concat(r.conname);
    }
  }

  // Tabelas pedidas que o banco não tem: ficam REGISTRADAS como ausentes, para a camada 1 poder
  // dizer "não existe no banco" em vez de "o dump está velho".
  const ausentes = tabelas.filter((t) => !fora.tabelas[t]);

  const meta = {
    gerado_em: new Date().toISOString(),
    banco: ondeEstou.rows[0].db,
    porta: ondeEstou.rows[0].porta,
    postgres: String(ondeEstou.rows[0].versao).split(' ').slice(0, 2).join(' '),
    tabelas_pedidas: tabelas,
    tabelas_ausentes: ausentes,
    como_refazer: 'node deploy/dump-esquema-demo.js',
    fonte_da_lista: 'src/demo/cenario-mf8.js → tabelasDoPlano(plano(...)) — NÃO editar à mão',
  };

  fs.mkdirSync(path.dirname(saida), { recursive: true });
  fs.writeFileSync(saida, `${JSON.stringify({ _meta: meta, ...fora }, null, 2)}\n`, 'utf8');

  const nCol = Object.values(fora.tabelas).reduce((a, t) => a + Object.keys(t.colunas).length, 0);
  const nChk = Object.values(fora.tabelas).reduce((a, t) => a + t.checks.length, 0);
  console.log(`\nBanco: ${meta.banco} (${meta.postgres})`);
  console.log(`Lidas: ${Object.keys(fora.tabelas).length} tabelas, ${nCol} colunas, ${nChk} restrições CHECK.`);
  if (ausentes.length) {
    console.log(`\n⚠ ${ausentes.length} tabela(s) do plano NÃO existem neste banco:`);
    ausentes.forEach((t) => console.log(`    ${t}`));
    console.log('  O seed não pode rodar aqui enquanto isso for verdade.');
  }
  console.log(`\nEscrito em ${saida}`);
  await pool.end();
  if (ausentes.length) process.exit(2);
}

principal().catch((e) => {
  console.error(`ERRO: ${e.message}`);
  process.exit(1);
});
