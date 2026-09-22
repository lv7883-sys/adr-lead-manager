'use strict';
//
// perfil-assistente.test.js — PERFIL DA ASSISTENTE por empresa (migr. 119).
//
// Pedido do dono (16/09/2026): a assistente precisa ser configurada com CONTEXTO, TIPO COMPORTAMENTAL e
// o que ela NÃO DEVE FALAR, pensando em empresas de outros ramos além de escola de música.
//
// O que estes testes protegem:
//   1) Empresa SEM perfil configurado recebe o texto de sempre (nenhuma unidade muda sem querer).
//   2) Empresa de outro ramo não recebe "aula experimental", "instrumento", "escola de música".
//   3) Comportamento e assuntos proibidos chegam em TODOS os caminhos de geração.
//   4) Assunto proibido escrito no texto é pego sem IA.
//
const test = require('node:test');
const assert = require('node:assert/strict');

// Gemini falso: captura o prompt que cada função monta.
process.env.GEMINI_API_KEY = 'teste';
const capt = [];
let resposta = '{"estrategia":"e","rascunho":"r"}';
const genai = require.resolve('@google/generative-ai');
require.cache[genai] = { id: genai, filename: genai, loaded: true, exports: {
  GoogleGenerativeAI: class { getGenerativeModel(o) { return { generateContent: async (arg) => {
    capt.push(`${o.systemInstruction || ''}\n${typeof arg === 'string' ? arg : ''}`);
    return { response: { text: () => resposta } };
  } }; } },
} };
const gemini = require('../src/gemini');
const perfilIA = require('../src/perfilAssistente');
const { resolveSystemPrompt } = require('../src/templates');

const CLINICA = {
  ramo_atividade: 'Clínica odontológica', objetivo_conversa: 'agendar uma avaliação gratuita',
  estilo_ia: 'profissional', comportamento_ia: 'Trate por senhor(a).', nao_falar: ['concorrentes', 'política'],
  contexto_ia: 'Ficamos na Rua A, 10.',
};
const MUSICA = /escola de m[úu]sica|instrumento|aula experimental|experimental|matr[íi]cula|professor|\baula/i;

async function todosOsPrompts(perfil) {
  resposta = '{"estrategia":"e","rascunho":"r"}';
  const h = [{ role: 'USER', content: 'oi' }, { role: 'ASSISTANT', content: 'olá' }];
  const sp = resolveSystemPrompt({ system_prompt_override: null, school_name: 'Sorriso', available_instruments: [], perfil });
  const saidas = {};
  const rodar = async (nome, fn) => { capt.length = 0; await fn(); saidas[nome] = capt.join('\n'); };
  await rodar('sugestao', () => gemini.generateReply({ systemPrompt: sp, history: h, message: 'x', retomada: true, vendas: true, perfil }));
  await rodar('sugestao_normal', () => gemini.generateReply({ systemPrompt: sp, history: h, message: 'x', retomada: true, perfil }));
  await rodar('renovacao_venda', () => gemini.generateReply({ systemPrompt: sp, history: h, message: 'x', vendas: true, contexto: 'renovacao', perfil }));
  await rodar('fora_do_horario', () => gemini.generateReply({ systemPrompt: sp, history: h, message: 'x', persona: 'assistente', transcript: 'T', perfil }));
  await rodar('estrategia', () => gemini.estrategiaVendas({ systemPrompt: sp, clientHistory: h, message: 'm', escola: 'Sorriso', nomeIa: 'Ana', contexto: 'lead', perfil }));
  await rodar('melhorar', () => gemini.improveReply({ systemPrompt: sp, history: h, draft: 'rascunho', perfil }));
  await rodar('assistente_interno', () => gemini.assistantReply({ schoolContext: sp, leadName: 'L', leadConversation: 'C', message: 'm', perfil }));
  await rodar('retomada', () => gemini.sugestaoRetomada({ history: h, leadName: 'L', schoolContext: sp, perfil }));
  await rodar('renovacao', () => gemini.sugestaoRenovacao({ marco: 'D-10', alunoNome: 'A', servico: 'Plano', dataFimISO: '2026-10-01', schoolContext: sp, nomeIa: 'Ana', perfil }));
  return saidas;
}

test('empresa de OUTRO RAMO: nenhum caminho fala de escola de música, aula ou instrumento', async () => {
  const saidas = await todosOsPrompts(CLINICA);
  for (const [nome, texto] of Object.entries(saidas)) {
    const m = texto.match(MUSICA);
    assert.equal(m, null, `${nome} ainda fala "${m && m[0]}"`);
  }
  assert.match(saidas.sugestao, /agendar uma avaliação gratuita/, 'o objetivo da empresa substitui a aula experimental');
});

test('comportamento e assuntos proibidos chegam em todos os caminhos de geração', async () => {
  const saidas = await todosOsPrompts(CLINICA);
  for (const [nome, texto] of Object.entries(saidas)) {
    assert.match(texto, /ASSUNTOS PROIBIDOS[\s\S]*"concorrentes"; "política"/, `${nome} sem os assuntos proibidos`);
    assert.match(texto, /Tipo comportamental: PROFISSIONAL/, `${nome} sem o tipo comportamental`);
    assert.match(texto, /Trate por senhor\(a\)\./, `${nome} sem as instruções de comportamento`);
  }
});

test('com comportamento definido, o "sem emojis" fixo dá lugar ao que a empresa escolheu', async () => {
  const saidas = await todosOsPrompts({ estilo_ia: 'descontraida' });
  assert.doesNotMatch(saidas.retomada, /sem emojis/);
  assert.match(saidas.retomada, /uso de emojis definidos em COMO SE COMPORTAR/);
  assert.match(saidas.retomada, /escola de música/, 'sem ramo/objetivo o texto de escola continua');
});

test('empresa SEM perfil: prompt da unidade sai exatamente como ela escreveu', () => {
  assert.equal(resolveSystemPrompt({ system_prompt_override: 'Prompt da unidade', available_instruments: [], perfil: null }), 'Prompt da unidade');
});

// Desde 22/09/2026 o bloco do perfil SEMPRE carrega a regra de nome (a IA se apresentava com o nome
// de uma recepcionista real). Perfil carregado e sem nome configurado = ela fala pela empresa.
test('perfil carregado sem nome: nada de apresentação pessoal (e nenhum nome chumbado)', () => {
  const p = resolveSystemPrompt({ system_prompt_override: 'Prompt da unidade', perfil: perfilIA.doBanco({}) });
  assert.match(p, /^Prompt da unidade\n\nVOCÊ NÃO TEM NOME PRÓPRIO configurado/);
  assert.match(perfilIA.blocoPerfil({ nao_falar: [], estilo_ia: 'inexistente' }), /NÃO TEM NOME PRÓPRIO/);
  assert.match(perfilIA.blocoPerfil({ nome_ia: 'Ana' }), /SEU NOME: Ana\./);
});

test('o texto que veio da empresa não é reescrito pelas trocas de ramo', async () => {
  capt.length = 0;
  const sp = 'Somos uma escola de música também, com aula experimental.';   // prompt próprio da empresa
  await gemini.generateReply({ systemPrompt: sp, history: [], message: 'x', perfil: CLINICA });
  assert.ok(capt[0].includes(sp), 'o prompt da empresa ficou intacto');
});

test('assunto proibido ESCRITO no texto é pego sem IA (sem acento, maiúscula, pontuação)', () => {
  assert.equal(perfilIA.assuntoEscrito('O que acha da POLÍTICA atual?', ['política']), 'política');
  assert.equal(perfilIA.assuntoEscrito('vocês são melhores que os concorrentes?', ['concorrentes']), 'concorrentes');
  assert.equal(perfilIA.assuntoEscrito('quero falar de preço de concorrente', ['preço de concorrente']), 'preço de concorrente');
  assert.equal(perfilIA.assuntoEscrito('políticas de privacidade', ['política']), null, 'palavra inteira: "políticas" não é "política"');
  assert.equal(perfilIA.assuntoEscrito('bom dia', []), null);
});

test('API: lerCorpo só leva o que veio e valida o tipo comportamental', () => {
  assert.deepEqual(perfilIA.lerCorpo({}), {}, 'nada veio = nada muda');
  const c = perfilIA.lerCorpo({ ramo_atividade: '  Academia  ', estilo_ia: 'hacker', nao_falar: ['Política', 'politica', '', 'x'.repeat(200)] });
  assert.equal(c.ramo_atividade, 'Academia');
  assert.equal(c.estilo_ia, '', 'estilo desconhecido vira "sem estilo"');
  assert.deepEqual(c.nao_falar.map((a) => a.length), [8, 120], 'sem repetido com/sem acento, vazio fora, teto de 120');
});

test('tocaAssuntoProibido: lista vazia não chama a IA; resposta da IA é lida com segurança', async () => {
  capt.length = 0;
  assert.deepEqual(await gemini.tocaAssuntoProibido({ texto: 'oi', assuntos: [] }), { toca: false, assunto: null });
  assert.equal(capt.length, 0);
  resposta = '{"toca": true, "assunto": "política"}';
  assert.deepEqual(await gemini.tocaAssuntoProibido({ texto: 'quem ganha a eleição?', assuntos: ['política'] }), { toca: true, assunto: 'política' });
  resposta = '{"toca": false, "assunto": ""}';
  assert.deepEqual(await gemini.tocaAssuntoProibido({ texto: 'bom dia', assuntos: ['política'] }), { toca: false, assunto: null });
});

test('trava: classificador fora do ar = barra (erra para o lado seguro)', async () => {
  const trava = require('../src/travaAssunto');
  assert.equal(await trava.verificar('bom dia', ['política'], { checar: async () => ({ toca: false }) }), null);
  assert.deepEqual(await trava.verificar('eleição', ['política'], { checar: async () => ({ toca: true, assunto: 'política' }) }), { tema: 'nao_falar', trecho: 'política' });
  const r = await trava.verificar('bom dia', ['política'], { checar: async () => { throw new Error('503'); } });
  assert.equal(r.tema, 'nao_falar');
  assert.equal(await trava.verificar('qualquer coisa', [], { checar: async () => { throw new Error('não deveria chamar'); } }), null);
});
