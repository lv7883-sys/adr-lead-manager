'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

// gemini-2.0-flash foi descontinuado (404). Default atual: gemini-2.5-flash;
// sobrescrevível por GEMINI_MODEL.
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

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
// `clarification` (opcional): instrução para repergunta de dado ambíguo (E1-03).
async function generateReply({ systemPrompt, history = [], message, clarification }) {
  const sys = clarification
    ? `${systemPrompt}\n\nNESTA RESPOSTA, peça educadamente que o lead esclareça: ${clarification}.`
    : systemPrompt;
  const model = client().getGenerativeModel({ model: MODEL, systemInstruction: sys });
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

// E1-02 — classifica a intenção do lead em uma das 4 categorias.
const INTENTS = ['SCHEDULE_INTEREST', 'PRICE_INQUIRY', 'GENERAL_INFO', 'OUT_OF_SCOPE'];
const INTENT_PROMPT = `Classifique a intenção principal da mensagem do lead de uma escola de música em UMA categoria:
- SCHEDULE_INTEREST: quer agendar/marcar aula experimental, visita ou horário.
- PRICE_INQUIRY: pergunta sobre preço, valores, mensalidade ou planos.
- GENERAL_INFO: dúvidas gerais sobre a escola, instrumentos ou funcionamento.
- OUT_OF_SCOPE: assunto não relacionado a aulas/escola de música.
Responda SOMENTE com JSON: {"intent":"<categoria>"}`;

async function classifyIntent({ message }) {
  const model = client().getGenerativeModel({
    model: MODEL,
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });
  const res = await model.generateContent(`${INTENT_PROMPT}\n\nMensagem: """${message ?? ''}"""`);
  const parsed = JSON.parse(res.response.text());
  return INTENTS.includes(parsed.intent) ? parsed.intent : 'GENERAL_INFO';
}

// E1-03 — extrai nome, instrumento e disponibilidade da conversa.
const EXTRACT_PROMPT = `Extraia da conversa os dados do lead para matrícula em escola de música.
Campos:
- name: nome da pessoa.
- instrument: instrumento de interesse.
- availability: disponibilidade de horário.
Para cada campo: se informado de forma clara, retorne o valor (string); se foi mencionado mas está
ambíguo/incompleto, retorne null e inclua o nome do campo em "ambiguous"; se não foi mencionado, null.
Responda SOMENTE com JSON: {"name":<str|null>,"instrument":<str|null>,"availability":<str|null>,"ambiguous":[<campos>]}`;

async function extractQualification({ history = [], message }) {
  const model = client().getGenerativeModel({
    model: MODEL,
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });
  const convo = history.map((m) => `${m.role}: ${m.content ?? ''}`).join('\n');
  const res = await model.generateContent(
    `${EXTRACT_PROMPT}\n\nConversa:\n${convo}\nUSER: ${message ?? ''}`
  );
  const p = JSON.parse(res.response.text());
  return {
    name: p.name ?? null,
    instrument: p.instrument ?? null,
    availability: p.availability ?? null,
    ambiguous: Array.isArray(p.ambiguous) ? p.ambiguous : [],
  };
}

module.exports = { classify, generateReply, classifyIntent, extractQualification, INTENTS, MODEL };
