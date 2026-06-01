'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

function client() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY não configurada');
  return new GoogleGenerativeAI(key);
}

// Portão 1 — prompt de triagem curto. Decide LEAD vs NOT_LEAD.
const TRIAGE_PROMPT = `Você é um classificador de triagem de mensagens de WhatsApp de uma escola de música.
Decida se a mensagem vem de um LEAD (pessoa potencialmente interessada em contratar/conhecer aulas)
ou NOT_LEAD (qualquer outra coisa: equipe interna, aluno já matriculado tratando de assuntos
administrativos, fornecedor, parceiro, spam, mensagem irrelevante ou ambígua).

Na dúvida, classifique como NOT_LEAD. Responda SOMENTE com JSON no formato:
{"label":"LEAD"|"NOT_LEAD","confidence":<0.0-1.0>,"reason":"<curto>"}`;

async function classify({ message }) {
  const model = client().getGenerativeModel({
    model: MODEL,
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });
  const res = await model.generateContent(`${TRIAGE_PROMPT}\n\nMensagem: """${message ?? ''}"""`);
  const parsed = JSON.parse(res.response.text());
  return {
    label: parsed.label === 'LEAD' ? 'LEAD' : 'NOT_LEAD',
    confidence: Number(parsed.confidence) || 0,
    reason: typeof parsed.reason === 'string' ? parsed.reason : null,
  };
}

// Portão 2 — geração da resposta, com system prompt do tenant + histórico.
async function generateReply({ systemPrompt, history = [], message }) {
  const model = client().getGenerativeModel({ model: MODEL, systemInstruction: systemPrompt });
  const contents = [
    ...history.map((m) => ({
      role: m.role === 'ASSISTANT' ? 'model' : 'user',
      parts: [{ text: m.content ?? m.body ?? '' }],
    })),
    { role: 'user', parts: [{ text: message ?? '' }] },
  ];
  const res = await model.generateContent({ contents });
  return res.response.text();
}

module.exports = { classify, generateReply, MODEL };
