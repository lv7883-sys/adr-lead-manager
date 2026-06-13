'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('./logger');

// Cadeia de modelos: o configurado (GEMINI_MODEL) primeiro, depois fallbacks
// estáveis — incluindo os aliases *-latest, que acompanham automaticamente o
// modelo flash mais novo. Se o modelo ativo for descontinuado (404 / "no longer
// available"), o próximo da cadeia é tentado e o que funcionar é memoizado,
// de modo que a automação se atualiza sozinha sem deploy.
const CANDIDATES = [
  ...new Set(
    [
      process.env.GEMINI_MODEL,
      'gemini-2.5-flash',
      'gemini-flash-latest',
      'gemini-2.5-flash-lite',
      'gemini-flash-lite-latest',
    ].filter(Boolean)
  ),
];
let activeIndex = 0;
const getActiveModel = () => CANDIDATES[activeIndex];

function client() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY não configurada');
  return new GoogleGenerativeAI(key);
}

// Detecta "modelo indisponível/descontinuado" para acionar o fallback (e NÃO
// para erros normais, como JSON malformado — esses são propagados).
function isModelUnavailable(err) {
  return /no longer available|not found|404|is not supported|does not exist|deprecated/i.test(
    String(err?.message || '')
  );
}

// Executa run(modelName) começando pelo modelo ativo; em erro de
// indisponibilidade, avança na cadeia, memoiza o que funcionar e loga a troca.
async function withModelFallback(run) {
  let lastErr;
  for (let i = activeIndex; i < CANDIDATES.length; i += 1) {
    try {
      const res = await run(CANDIDATES[i]);
      if (i !== activeIndex) {
        logger.warn('gemini.model_switched', { from: CANDIDATES[activeIndex], to: CANDIDATES[i] });
        activeIndex = i;
      }
      return res;
    } catch (err) {
      if (isModelUnavailable(err)) {
        logger.warn('gemini.model_unavailable', { model: CANDIDATES[i], error: err.message });
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('nenhum modelo Gemini disponível');
}

// Portão 1 — prompt de triagem curto. Decide LEAD vs NOT_LEAD.
const TRIAGE_PROMPT = `Você é um classificador de triagem de mensagens de WhatsApp de uma escola de música.
Decida se a mensagem vem de um LEAD (pessoa potencialmente interessada em contratar/conhecer aulas)
ou NOT_LEAD (qualquer outra coisa: equipe interna, aluno já matriculado tratando de assuntos
administrativos, fornecedor, parceiro, spam, mensagem irrelevante ou ambígua).

Responda SOMENTE com JSON no formato:
{"is_lead":<true|false>,"confidence":<0.0-1.0>,"reasoning":"<explicação em português, 1 frase>","suggested_temperature":"quente"|"morno"|"frio","profile_signals":["<sinais curtos>"]}

REGRAS:
- "confidence" é a PROBABILIDADE de a mensagem vir de um LEAD (0.0 = certeza que NÃO é lead; 1.0 = certeza que É lead). Use a escala toda; na dúvida real, fique perto de 0.5.
- "is_lead" = true quando confidence >= 0.5.
- "reasoning": uma frase curta explicando a decisão (ex: "perguntou sobre horários mas não mencionou instrumento").
- "suggested_temperature": quão quente parece o interesse (quente|morno|frio).
- "profile_signals": lista curta de sinais úteis pra recepção (ex: "adulto", "iniciante", "urgência baixa"); pode ser vazia.`;

const TEMPS_VALIDAS = ['quente', 'morno', 'frio'];
async function classify({ message }) {
  return withModelFallback(async (modelName) => {
    const model = client().getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    const res = await model.generateContent(`${TRIAGE_PROMPT}\n\nMensagem: """${message ?? ''}"""`);
    const parsed = JSON.parse(res.response.text());
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
    const isLead = typeof parsed.is_lead === 'boolean' ? parsed.is_lead : confidence >= 0.5;
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning
      : (typeof parsed.reason === 'string' ? parsed.reason : null);
    return {
      is_lead: isLead,
      confidence,
      reasoning,
      suggested_temperature: TEMPS_VALIDAS.includes(parsed.suggested_temperature) ? parsed.suggested_temperature : null,
      profile_signals: Array.isArray(parsed.profile_signals)
        ? parsed.profile_signals.filter((s) => typeof s === 'string').slice(0, 8) : [],
      // compat com chamadas antigas:
      label: isLead ? 'LEAD' : 'NOT_LEAD',
      reason: reasoning,
    };
  });
}

// Portão 2 — geração da resposta, com system prompt do tenant + histórico.
// `clarification` (opcional): instrução para repergunta de dado ambíguo (E1-03).
async function generateReply({ systemPrompt, history = [], message, clarification, retomada }) {
  let sys = systemPrompt;
  // RETOMADA: quando JÁ existe conversa anterior (histórico real), a IA não deve tratar
  // como primeiro contato. Condiciona a apresentação/"REFERÊNCIA DE VOZ" do prompt a só
  // valerem sem histórico, e orienta uma retomada contextualizada.
  if (retomada) {
    sys +=
      '\n\nRETOMADA — JÁ EXISTE conversa anterior com esta pessoa (veja o histórico acima). ' +
      'NÃO se apresente de novo nem trate como primeiro contato. IGNORE a instrução de ' +
      '"primeira mensagem" e a "REFERÊNCIA DE VOZ" (elas valem só quando NÃO há histórico). ' +
      'Identifique onde a conversa parou e qual foi o último assunto, referencie isso de forma ' +
      'natural e calorosa, e reconecte avançando para o agendamento da aula experimental. ' +
      'Não invente nada que não foi discutido.';
  }
  if (clarification) {
    sys += `\n\nNESTA RESPOSTA, peça educadamente que o lead esclareça: ${clarification}.`;
  }
  return withModelFallback(async (modelName) => {
    // temperature baixa (0.3) = respostas mais consistentes e ancoradas no prompt,
    // menos "criativas"/inventadas. Os classificadores já rodam em 0; aqui mantemos um
    // mínimo de naturalidade pra conversa sem abrir espaço pra alucinação.
    const model = client().getGenerativeModel({
      model: modelName,
      systemInstruction: sys,
      generationConfig: { temperature: 0.3 },
    });
    const contents = [
      ...history.map((m) => ({
        role: m.role === 'ASSISTANT' ? 'model' : 'user',
        parts: [{ text: m.content ?? m.body ?? '' }],
      })),
      { role: 'user', parts: [{ text: message ?? '' }] },
    ];
    const res = await model.generateContent({ contents });
    return res.response.text();
  });
}

// D — "Melhorar com IA": revisa um rascunho escrito/editado pela recepcionista,
// mantendo a INTENÇÃO e as informações dela. Não inventa dados. Retorna só o texto.
async function improveReply({ systemPrompt, history = [], draft }) {
  const ctx = history.length
    ? '\n\nContexto recente da conversa (mais antigo -> mais novo):\n' +
      history.slice(-6).map((m) => `${m.role === 'ASSISTANT' ? 'Escola' : 'Lead'}: ${m.content ?? m.body ?? ''}`).join('\n')
    : '';
  const prompt =
    `${systemPrompt}\n\n` +
    'TAREFA: revise e melhore o RASCUNHO de resposta abaixo, escrito pela recepcionista. ' +
    'Corrija o português, ajuste ao tom da escola (sem emojis, "você", cordial e claro) e deixe natural — ' +
    'MAS mantenha a intenção e as informações que ela colocou. NÃO invente dados (endereço, preço, nomes, ' +
    'horários) que não estejam no contexto/prompt. Responda SOMENTE com a mensagem final melhorada, ' +
    `sem comentários nem aspas.${ctx}\n\nRASCUNHO:\n${draft ?? ''}`;
  return withModelFallback(async (modelName) => {
    const model = client().getGenerativeModel({
      model: modelName,
      generationConfig: { temperature: 0.3 },
    });
    const res = await model.generateContent(prompt);
    return res.response.text().trim();
  });
}

// E1 — Assistente operacional da RECEPÇÃO: ajuda a recepcionista a atender (o que dizer,
// como conduzir, agendar, lidar com objeções). NÃO fala com o cliente — orienta a pessoa.
// Usa as informações da escola como base; não inventa dados.
async function assistantReply({ schoolContext, leadName, leadConversation, history = [], message }) {
  const sys =
    'Você é um assistente interno que AJUDA A RECEPCIONISTA de uma escola de música a ' +
    'atender bem ESTE lead específico. Responda dúvidas operacionais (o que dizer, como ' +
    'conduzir, como agendar a aula experimental, como contornar objeções, como melhorar um ' +
    'rascunho) de forma clara e direta, em português do Brasil. Você NÃO fala com o cliente ' +
    '— você orienta a recepcionista. Use a CONVERSA COM ESTE LEAD para dar respostas ' +
    'específicas (ex.: a objeção que ele fez). Baseie-se nas INFORMAÇÕES DA ESCOLA. Se não ' +
    'tiver um dado, diga que não tem (não invente endereço, preço, nomes ou horários).' +
    (leadName ? `\n\nLEAD: ${leadName}` : '') +
    (leadConversation ? `\n\nCONVERSA COM ESTE LEAD (mais antigo -> mais novo):\n${leadConversation}` : '') +
    (schoolContext ? `\n\nINFORMAÇÕES DA ESCOLA (referência):\n${schoolContext}` : '');
  return withModelFallback(async (modelName) => {
    const model = client().getGenerativeModel({
      model: modelName,
      systemInstruction: sys,
      generationConfig: { temperature: 0.3 },
    });
    const contents = [
      ...history.map((m) => ({
        role: String(m.role).toLowerCase() === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content ?? m.text ?? '' }],
      })),
      { role: 'user', parts: [{ text: message ?? '' }] },
    ];
    const res = await model.generateContent({ contents });
    return res.response.text().trim();
  });
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
  return withModelFallback(async (modelName) => {
    const model = client().getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    const res = await model.generateContent(`${INTENT_PROMPT}\n\nMensagem: """${message ?? ''}"""`);
    const parsed = JSON.parse(res.response.text());
    return INTENTS.includes(parsed.intent) ? parsed.intent : 'GENERAL_INFO';
  });
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
  return withModelFallback(async (modelName) => {
    const model = client().getGenerativeModel({
      model: modelName,
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
  });
}

// ADR-016 — transcreve um áudio recebido (base64) para texto pt-BR. Best-effort.
async function transcribeAudio({ base64, mimetype }) {
  if (!base64) return null;
  return withModelFallback(async (modelName) => {
    const model = client().getGenerativeModel({ model: modelName, generationConfig: { temperature: 0 } });
    const res = await model.generateContent([
      { inlineData: { data: base64, mimeType: (mimetype || 'audio/ogg').split(';')[0].trim() } },
      { text: 'Transcreva este áudio em português brasileiro. Retorne só a transcrição, sem explicações.' },
    ]);
    const t = res.response.text();
    return typeof t === 'string' ? t.trim() : null;
  });
}

module.exports = {
  classify,
  transcribeAudio,
  generateReply,
  improveReply,
  assistantReply,
  classifyIntent,
  extractQualification,
  INTENTS,
  CANDIDATES,
  getActiveModel,
};
