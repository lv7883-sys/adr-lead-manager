'use strict';
//
// conformidade.js — CAMADA 1 das três conferências do seed de demonstração.
//
// O que ela faz: pega o PLANO (dado puro, de `cenario-mf8.js`) e o ESQUEMA CONGELADO (lido de
// produção por `deploy/dump-esquema-demo.js`) e responde, sem banco nenhum, se cada linha que
// seria gravada cabe na tabela que existe de verdade — nome de coluna, obrigatoriedade, coluna
// gerada e restrição CHECK.
//
// ─── POR QUE TRÊS CAMADAS, E NÃO UMA ─────────────────────────────────────────────────────────
//
//   1. ESTA — sem banco, contra as restrições CHECK reais. Roda em `npm test`, na máquina de
//      qualquer pessoa, e é a única que diz "o valor 'D-45' não serve" ANTES de alguém ter acesso
//      a produção. Não vê tipo de dado de verdade, nem gatilho, nem chave estrangeira.
//   2. `PREPARE` de cada INSERT contra a tabela real (no script de gravação). Valida nome de
//      coluna, aridade e tipo, sem executar nada — pega o que o esquema congelado tiver de
//      desatualizado, que é o furo desta camada aqui.
//   3. UMA transação só, tudo ou nada. Pega o que só o dado existente revela: chave estrangeira,
//      índice único, gatilho.
//
// Cada uma pega o que as outras não pegam. É por isso que são três, e não a "melhor" delas.
//
// ─── A LISTA DE TABELAS NÃO É ESCRITA À MÃO ──────────────────────────────────────────────────
//
// Em 31/10/2026, no dashboard, a gravação do cenário morreu na SEXTA de oito tabelas com 22
// testes verdes: a lista de CHECKs conferidos tinha sido digitada separadamente do plano e
// esqueceu uma tabela. A lista das tabelas a conferir era a lista das tabelas conferidas.
//
// Aqui a lista sai de `tabelasDoPlano(plano)` e tabela do plano que não esteja no esquema
// congelado é ERRO — nunca omissão silenciosa. É a diferença inteira.
//
const { avaliaCheck, normalizaDefinicao } = require('./check-sql');
const { tabelasDoPlano } = require('./cenario-mf8');

/**
 * Confere o plano contra o esquema congelado.
 *
 * @param {Array} plano  saída de cenario-mf8.plano()
 * @param {{tabelas: Record<string, {colunas: Record<string, object>, checks: string[]}>}} esquema
 * @returns {{ok: boolean, problemas: string[], conferido: {tabelas: number, linhas: number, checks: number}}}
 */
function confere(plano, esquema) {
  const problemas = [];
  if (!esquema || !esquema.tabelas || typeof esquema.tabelas !== 'object') {
    throw new Error(
      'conformidade: esquema congelado ausente ou sem a chave `tabelas`. Gere-o com '
      + '`node deploy/dump-esquema-demo.js` contra o banco onde o seed vai rodar. '
      + 'Sem ele esta camada não CONFERE nada — e não vai fingir que conferiu.');
  }

  const tabelas = tabelasDoPlano(plano);
  let linhasConferidas = 0;
  let checksAvaliados = 0;

  for (const nome of tabelas) {
    const t = esquema.tabelas[nome];
    if (!t) {
      // ⭐ Este é o erro que o dashboard não deu em 31/10/2026, e por isso o seed quebrou no
      // banco. A tabela está no plano e não está no esquema congelado: o dump está velho, ou a
      // tabela não existe. Em nenhum dos dois casos a conferência vale.
      problemas.push(
        `[${nome}] está no PLANO e NÃO está no esquema congelado — refaça o dump `
        + '(`node deploy/dump-esquema-demo.js`). Enquanto isso, esta tabela está SEM conferência.');
      continue;
    }
    const colunasConhecidas = new Set(Object.keys(t.colunas || {}));
    const checks = (t.checks || []).map(normalizaDefinicao);

    for (const bloco of plano.filter((b) => b.tabela === nome)) {
      // 1) toda coluna escrita existe, e nenhuma coluna GERADA é escrita
      for (const col of bloco.colunas) {
        const meta = (t.colunas || {})[col];
        if (!meta) {
          problemas.push(`[${nome}] o plano escreve a coluna ${JSON.stringify(col)}, que não existe na tabela.`);
          continue;
        }
        if (meta.gerada) {
          problemas.push(
            `[${nome}] o plano escreve ${JSON.stringify(col)}, que é coluna GERADA — o banco recusa `
            + 'INSERT em coluna gerada (e é ela que casa conversa × cadastro).');
        }
      }

      // 2) toda coluna obrigatória SEM default está no plano
      for (const [col, meta] of Object.entries(t.colunas || {})) {
        if (meta.nulo === false && !meta.temDefault && !meta.gerada && !bloco.colunas.includes(col)) {
          problemas.push(
            `[${nome}] a coluna ${JSON.stringify(col)} é NOT NULL e não tem default, e o plano não a escreve.`);
        }
      }

      // 3) linha por linha: obrigatoriedade e CHECKs
      bloco.linhas.forEach((valores, idx) => {
        if (valores.length !== bloco.colunas.length) {
          problemas.push(
            `[${nome}] linha ${idx}: ${valores.length} valores para ${bloco.colunas.length} colunas.`);
          return;
        }
        linhasConferidas += 1;
        const linha = Object.fromEntries(bloco.colunas.map((c, k) => [c, valores[k]]));

        for (const [col, v] of Object.entries(linha)) {
          const meta = (t.colunas || {})[col];
          if (meta && meta.nulo === false && v === null) {
            problemas.push(`[${nome}] linha ${idx}: ${JSON.stringify(col)} é NOT NULL e o plano manda null.`);
          }
        }

        for (const def of checks) {
          checksAvaliados += 1;
          let r;
          try {
            r = avaliaCheck(def, linha, { colunasConhecidas });
          } catch (e) {
            // Restrição que o avaliador não entende NÃO passa calada. Ela vira problema, com o
            // texto original, para alguém olhar e estender o avaliador — ou corrigir o plano.
            problemas.push(`[${nome}] linha ${idx}: ${e.message}`);
            continue;
          }
          // No PostgreSQL só FALSE reprova; NULL (desconhecido) passa.
          if (r === false) {
            problemas.push(
              `[${nome}] linha ${idx}: reprovada pela restrição ${JSON.stringify(def)}. `
              + `Valores: ${JSON.stringify(linha)}`);
          }
        }
      });
    }
  }

  return {
    ok: problemas.length === 0,
    problemas,
    conferido: { tabelas: tabelas.length, linhas: linhasConferidas, checks: checksAvaliados },
  };
}

/**
 * Como `confere`, mas LANÇA com a lista inteira de problemas.
 *
 * Lista inteira, não o primeiro: mensagem de erro mostra onde parou, não o que falta. Quem
 * precisa consertar um seed precisa do ESTADO (as 9 linhas ruins), não do primeiro sintoma.
 */
function exigeConformidade(plano, esquema) {
  const r = confere(plano, esquema);
  if (!r.ok) {
    throw new Error(
      `conformidade: ${r.problemas.length} problema(s) entre o plano e o esquema real `
      + `(${r.conferido.tabelas} tabelas, ${r.conferido.linhas} linhas, ${r.conferido.checks} restrições avaliadas):\n`
      + r.problemas.map((p) => `  • ${p}`).join('\n'));
  }
  return r;
}

module.exports = { confere, exigeConformidade };
