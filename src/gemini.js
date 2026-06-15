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

Analise o CONTEXTO COMPLETO da mensagem, não apenas palavras isoladas. NÃO é lead quando:
- A conversa trata de operação interna da escola (horários, professores, eventos, materiais, reuniões).
- O conteúdo não tem nenhuma relação com interesse em fazer aulas ou conhecer a escola.
- É claramente uma troca entre funcionários/equipe.
- Fala sobre assuntos do dia a dia da escola (bolo, camisetas, salas, alunos já matriculados, bandas internas, eventos da escola).
- Menciona nomes de pessoas da equipe em contexto interno.
Nesses casos, retorne confidence < 0.10 com reasoning explicando que é comunicação interna.

Responda SOMENTE com JSON no formato:
{"is_lead":<true|false>,"confidence":<0.0-1.0>,"reasoning":"<explicação em português, 1 frase>","suggested_temperature":"quente"|"morno"|"frio","profile_signals":["<sinais curtos>"]}

REGRAS:
- "confidence" é a PROBABILIDADE de a mensagem vir de um LEAD (0.0 = certeza que NÃO é lead; 1.0 = certeza que É lead). Use a escala toda; na dúvida real, fique perto de 0.5.
- "is_lead" = true quando confidence >= 0.5.
- "reasoning": uma frase curta explicando a decisão (ex: "perguntou sobre horários mas não mencionou instrumento").
- "suggested_temperature": quão quente parece o interesse (quente|morno|frio).
- "profile_signals": lista curta de sinais úteis pra recepção (ex: "adulto", "iniciante", "urgência baixa"); pode ser vazia.`;

const TEMPS_VALIDAS = ['quente', 'morno', 'frio'];
// Few-shot dinâmico: correções reais da recepção (classification_feedback).
// `examples` = [{ label:'lead'|'not_lead', reasoning, context, temperature }].
function _fewShot(examples) {
  if (!Array.isArray(examples) || !examples.length) return '';
  const trecho = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const neg = examples.filter((e) => e.label === 'not_lead' && e.reasoning).slice(0, 5);
  const pos = examples.filter((e) => e.label === 'lead' && e.reasoning).slice(0, 5);
  if (!neg.length && !pos.length) return '';
  let s = '\n\nExemplos de classificações corrigidas nesta escola:';
  for (const e of neg) s += `\nEXEMPLO NEGATIVO: "${trecho(e.reasoning)}" → CORRETO: Não é lead.${e.context ? ' Motivo: ' + trecho(e.context) : ''}`;
  for (const e of pos) s += `\nEXEMPLO POSITIVO: "${trecho(e.reasoning)}" → CORRETO: É lead${e.temperature ? ' com temperatura ' + e.temperature : ''}.`;
  return s;
}

async function classify({ message, examples }) {
  return withModelFallback(async (modelName) => {
    const model = client().getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    const res = await model.generateContent(`${TRIAGE_PROMPT}${_fewShot(examples)}\n\nMensagem: """${message ?? ''}"""`);
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
  // Análise de tom/ritmo/momento/estilo ANTES de redigir: a sugestão deve ENTRAR no
  // fluxo da conversa (não reiniciá-la) e espelhar o jeito da recepcionista.
  sys +=
    '\n\nANTES DE SUGERIR UMA RESPOSTA, ANALISE A CONVERSA:' +
    '\n\n1. TOM: a conversa é formal ou informal?' +
    '\n   - Mensagens curtas e diretas = informal' +
    '\n   - Mensagens longas e elaboradas = formal' +
    '\n\n2. RITMO: qual o tamanho médio das mensagens?' +
    '\n   - Se curtas (1-2 frases) → responda em 1-2 frases' +
    '\n   - Se longas → pode ser mais elaborado' +
    '\n\n3. MOMENTO: onde estamos na conversa?' +
    '\n   - Início: pode ser mais apresentativo' +
    '\n   - Meio (conversa fluída): entre no fluxo, não reinicie' +
    '\n   - Fim (lead respondeu algo conclusivo): seja direto' +
    '\n\n4. ESTILO: como a recepcionista respondeu antes?' +
    '\n   - Replique o mesmo estilo nas suas sugestões' +
    '\n\nREGRAS OBRIGATÓRIAS:' +
    '\n- NUNCA chame a pessoa pelo nome se a conversa já está fluída sem isso' +
    "\n- NUNCA comece com 'Olá [nome]!' se já houve várias trocas de mensagens" +
    '\n- NUNCA gere texto longo se a conversa é de mensagens curtas' +
    '\n- Entre no ritmo da conversa, não reinicie ela' +
    '\n- Seja natural, como se você fosse a própria recepcionista continuando a conversa';
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

// PARTE 3 — sugestão de retomada de lead silencioso. Analisa a conversa e propõe
// uma abordagem natural e não invasiva. Retorna JSON {estrategia, rascunho}.
async function sugestaoRetomada({ history = [], leadName, schoolContext, engajamentoNota = '' }) {
  const convo = history
    .map((m) => `${String(m.role).toLowerCase() === 'assistant' ? 'Escola' : 'Lead'}: ${m.content ?? m.body ?? m.text ?? ''}`)
    .join('\n');
  const sys =
    'Você ajuda a recepção de uma escola de música a RETOMAR o contato com um lead que ' +
    'parou de responder. Analise a conversa abaixo e proponha uma reabordagem NATURAL, ' +
    'calorosa e SEM pressão — referenciando onde a conversa parou (o assunto/dúvida real), ' +
    'sem cobrar nem soar comercial. NÃO invente dados (preço, endereço, horários, nomes) que ' +
    'não estejam na conversa ou nas informações da escola.' +
    (leadName ? `\n\nLEAD: ${leadName}` : '') +
    (schoolContext ? `\n\nINFORMAÇÕES DA ESCOLA (referência):\n${schoolContext}` : '') +
    (engajamentoNota ? `\n\nPADRÃO DE ENGAJAMENTO DESTE CLIENTE (use para calibrar o tom e a abordagem):\n${engajamentoNota}` : '') +
    `\n\nCONVERSA (mais antigo -> mais novo):\n${convo || '(sem histórico)'}` +
    '\n\nResponda SOMENTE com JSON: {"estrategia":"<por que e como reabordar, 1-2 frases para a ' +
    'recepcionista>","rascunho":"<mensagem pronta para enviar ao lead, tom da escola, sem emojis>"}';
  return withModelFallback(async (modelName) => {
    const model = client().getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
    });
    const res = await model.generateContent(sys);
    const p = JSON.parse(res.response.text());
    return {
      estrategia: typeof p.estrategia === 'string' ? p.estrategia.trim() : '',
      rascunho: typeof p.rascunho === 'string' ? p.rascunho.trim() : '',
    };
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
  sugestaoRetomada,
  classifyIntent,
  extractQualification,
  INTENTS,
  CANDIDATES,
  getActiveModel,
};
