'use strict';
// sdk-ia-sem-atalho.test.js — TRAVA DE CUSTO ÓRFÃO.
//
// Falha se qualquer arquivo de src/ importar o SDK de IA direto. Só
// src/plataforma/ia.js pode — é lá que a chamada é medida e cobrada da unidade dona.
//
// Por que isto é um teste e não uma convenção escrita no README: convenção some com o
// tempo e com gente nova. Uma chamada de IA fora do ponto único é dinheiro gasto que não
// se atribui a ninguém, e num produto vendido por unidade isso é fatura que não fecha.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', 'src');
const PERMITIDO = path.join('plataforma', 'ia.js');

// O que caracteriza "falar com o SDK direto".
const PADROES = [
  { re: /require\(\s*['"]@google\/generative-ai['"]\s*\)/, o_que: "require('@google/generative-ai')" },
  { re: /from\s+['"]@google\/generative-ai['"]/, o_que: "import de '@google/generative-ai'" },
  { re: /new\s+GoogleGenerativeAI\s*\(/, o_que: 'new GoogleGenerativeAI(' },
  { re: /\.getGenerativeModel\s*\(/, o_que: '.getGenerativeModel(' },
];

function arquivosJs(dir) {
  const saida = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const completo = path.join(dir, entrada.name);
    if (entrada.isDirectory()) saida.push(...arquivosJs(completo));
    else if (entrada.name.endsWith('.js')) saida.push(completo);
  }
  return saida;
}

test('nenhum arquivo de src/ fala com o SDK de IA fora de plataforma/ia.js', () => {
  const infracoes = [];
  for (const arquivo of arquivosJs(RAIZ)) {
    const relativo = path.relative(RAIZ, arquivo);
    if (relativo === PERMITIDO) continue;
    const linhas = fs.readFileSync(arquivo, 'utf8').split(/\r?\n/);
    linhas.forEach((linha, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(linha)) return;   // comentário não chama nada
      for (const p of PADROES) {
        if (p.re.test(linha)) infracoes.push(`${relativo}:${i + 1} — ${p.o_que}`);
      }
    });
  }
  assert.deepEqual(infracoes, [],
    'chamada de IA fora do ponto único (custo órfão). Use src/plataforma/ia.js:\n' + infracoes.join('\n'));
});

test('o ponto único existe, importa o SDK e é o dono da medição', () => {
  const ia = fs.readFileSync(path.join(RAIZ, PERMITIDO), 'utf8');
  assert.match(ia, /require\(\s*['"]@google\/generative-ai['"]\s*\)/, 'ia.js deveria ser quem importa o SDK');
  assert.match(ia, /registrarUso/, 'ia.js deveria gravar consumo');
  assert.match(ia, /custo_orfao/, 'ia.js deveria avisar quando a chamada não tem dono');
});

test('gemini.js passa toda chamada pelo wrapper', () => {
  const gemini = fs.readFileSync(path.join(RAIZ, 'gemini.js'), 'utf8');
  const modelos = (gemini.match(/ia\.modelo\(/g) || []).length;
  assert.ok(modelos >= 10, `esperava vários ia.modelo(, achei ${modelos}`);
  assert.match(gemini, /ia\.medir\(/, 'withModelFallback deveria medir cada tentativa');
  assert.doesNotMatch(gemini, /GoogleGenerativeAI/, 'gemini.js não pode mais instanciar o SDK');
});
