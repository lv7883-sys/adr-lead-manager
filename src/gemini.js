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

async function classify({ message, examples, presignalNote }) {
  return withModelFallback(async (modelName) => {
    const model = client().getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    // ADR-029: pré-marca como CONTEXTO (sinal fraco, reavaliável), nunca veredito. Ausente → sem mudança.
    const nota = presignalNote ? `\n\nContexto (sinal fraco, reavalie do zero): ${presignalNote}` : '';
    const res = await model.generateContent(`${TRIAGE_PROMPT}${_fewShot(examples)}${nota}\n\nMensagem: """${message ?? ''}"""`);
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

// ============================================================================
// CLASSIFICADOR CONTEXT-AWARE (Fase build+validação) — SEPARADO de classify().
// Recebe a CONVERSA INTEIRA (lead + recepção, em ordem cronológica) e pede pra IA
// julgar com TODO o contexto, não a mensagem isolada. IA PURA, sem determinismo.
// NÃO é usada no fluxo vivo ainda — só build + validação.
//   conversation: [{ role:'USER'|'ASSISTANT', content, at? }]  (USER=lead, ASSISTANT=escola)
//   examples:     few-shot (mesmo formato de classify)
// Retorna { is_lead, confidence (0-1), reasoning, intent }.
// ============================================================================
const CONVERSA_INTENTS = ['NOVA_OPORTUNIDADE', 'ROTINA_CLIENTE', 'INTERNO', 'INDEFINIDO'];
const CONVERSA_STATES = ['AGUARDANDO_RECEPCAO', 'AGUARDANDO_CLIENTE', 'RESOLVIDO', 'INDEFINIDO'];

// Definição genérica padrão quando o tenant não setou `lead_definition` (multi-tenant
// limpo: nenhum domínio assumido — o classificador trabalha só com os princípios gerais).
const LEAD_DEFINITION_FALLBACK =
  'LEAD = pessoa demonstrando interesse real em contratar/adquirir o produto ou serviço do ' +
  'negócio, ou cliente existente trazendo uma NOVA oportunidade (novo produto, indicação, ' +
  'nova pessoa). ROTINA/NÃO-LEAD = cliente existente em assunto de pós-venda/administrativo do ' +
  'dia a dia, ou conversa interna/operacional da equipe.';

// Template GENÉRICO de triagem de conversa. A definição de negócio/lead NÃO fica cravada:
// vem do tenant (`lead_definition` em tenant_lead_config) e é injetada aqui. is_lead/intent/
// conversation_state continuam idênticos — só a DEFINIÇÃO de domínio é externalizada.
function _triageConversaPrompt(leadDefinition) {
  const def = (typeof leadDefinition === 'string' && leadDefinition.trim())
    ? leadDefinition.trim() : LEAD_DEFINITION_FALLBACK;
  return `Você é um classificador de triagem de conversas de WhatsApp de um negócio.
Recebe a CONVERSA INTEIRA entre a pessoa (LEAD) e o ATENDIMENTO (ATENDIMENTO), em ordem cronológica,
e decide se a conversa CORRENTE representa uma OPORTUNIDADE DE NOVO NEGÓCIO (lead) ou não.

DEFINIÇÃO DO NEGÓCIO E DE LEAD (deste cliente — use como critério principal):
${def}

PRINCÍPIO CENTRAL: a INTENÇÃO da conversa decide, NUNCA a identidade da pessoa.
Uma relação longa tem vários episódios — julgue a intenção ATUAL/RECENTE da conversa, não a pessoa
nem meses de histórico misturado. O que importa é se a conversa CORRENTE traz uma oportunidade nova.

NÃO é lead (is_lead=false):
- Cliente já existente tratando de ROTINA/pós-venda (conforme a definição acima): assuntos
  administrativos do dia a dia, remarcação, renovação, cobrança/pagamento, agradecimento, recado.
- Conversa interna/operacional da equipe do negócio.
- Assunto sem nenhuma relação com a oportunidade de negócio descrita na definição acima.

É lead (is_lead=true):
- Cliente existente trazendo NOVA oportunidade (conforme a definição acima): novo produto/serviço,
  indicação de outra pessoa, nova pessoa (família/empresa) interessada.
- Pessoa nova demonstrando interesse real na oferta do negócio.

ESTADO DA CONVERSA (conversation_state): leia a conversa INTEIRA e diga em que estado ela está
AGORA — com quem está a bola e se já foi resolvida. Julgue pelo CONTEXTO (não por palavras soltas):
- AGUARDANDO_RECEPCAO: o cliente fez a última jogada relevante (pergunta, pedido, interesse) e
  espera o atendimento responder/agir. A bola está com o atendimento.
- AGUARDANDO_CLIENTE: o atendimento respondeu/perguntou por último e espera o cliente (ele é quem
  deve responder). A bola está com o cliente.
- RESOLVIDO: a conversa chegou a um desfecho natural e NÃO pede ação imediata — ex.: agendamento/
  fechamento confirmados e o cliente só agradeceu/encerrou; assunto resolvido; despedida.
- INDEFINIDO: não dá pra ter certeza do estado.
SEGURANÇA: na dúvida entre RESOLVIDO e esperar resposta, escolha AGUARDANDO_RECEPCAO ou INDEFINIDO —
NUNCA marque RESOLVIDO sem certeza (não podemos esconder um cliente que ainda espera).

Responda SOMENTE com JSON:
{"is_lead":<true|false>,"confidence":<0.0-1.0>,"reasoning":"<1-2 frases em pt-BR citando o contexto da conversa>","intent":"NOVA_OPORTUNIDADE"|"ROTINA_CLIENTE"|"INTERNO"|"INDEFINIDO","conversation_state":"AGUARDANDO_RECEPCAO"|"AGUARDANDO_CLIENTE"|"RESOLVIDO"|"INDEFINIDO","state_reasoning":"<1 frase: com quem está a bola e por quê>"}

REGRAS:
- "confidence" = PROBABILIDADE de a conversa CORRENTE ser uma oportunidade de novo negócio (0.0 = certeza que NÃO; 1.0 = certeza que SIM). Use a escala toda; na dúvida real, ~0.5.
- "is_lead" = true quando confidence >= 0.5.
- "intent": NOVA_OPORTUNIDADE (novo negócio), ROTINA_CLIENTE (cliente em assunto de rotina), INTERNO (equipe/operacional), INDEFINIDO (não dá pra decidir).
- "reasoning": curto, citando o que na conversa justifica a decisão.
- "conversation_state": o estado ATUAL pela regra acima. "state_reasoning": 1 frase curta.`;
}

// ADR sugestão-de-etapa — bloco de prompt das DEFINIÇÕES de etapa do tenant.
// `stageDefinitions` = { key: "descrição natural do que dispara a etapa" } (vindo de
// tenant_lead_config.stage_definitions). Multi-tenant, SEM hardcode: sem defs → recurso
// desligado (o detector não sugere nada). Retorna { text, keys } pra validar a saída.
function _stageBlock(stageDefinitions) {
  if (!stageDefinitions || typeof stageDefinitions !== 'object') return { text: '', keys: [] };
  const keys = Object.keys(stageDefinitions).filter(
    (k) => typeof stageDefinitions[k] === 'string' && stageDefinitions[k].trim()
  );
  if (!keys.length) return { text: '', keys: [] };
  let s =
    '\n\nSUGESTÃO DE ETAPA (suggested_stage) — eixo de POSIÇÃO no funil, INDEPENDENTE de ' +
    'is_lead/intent/conversation_state. QUANDO E SOMENTE QUANDO is_lead=true, avalie se a ' +
    'conversa indica CLARAMENTE que o lead deveria estar em UMA destas etapas. Cada etapa tem ' +
    'uma condição; só sugira se a conversa satisfaz a condição sem ambiguidade. Se nenhuma se ' +
    'aplica com clareza, retorne suggested_stage=null.\nETAPAS POSSÍVEIS:';
  for (const k of keys) s += `\n- "${k}": ${String(stageDefinitions[k]).trim()}`;
  s +=
    '\nINCLUA TAMBÉM no JSON: "suggested_stage":"<uma das chaves acima, ou null>", ' +
    '"stage_reasoning":"<1 frase em pt-BR citando o trecho da conversa que dispara a etapa; ' +
    'vazio se null>". NUNCA invente uma chave fora da lista. Na dúvida, suggested_stage=null.';
  return { text: s, keys };
}

function _formatConversa(conversation) {
  if (!Array.isArray(conversation) || !conversation.length) return '(sem histórico)';
  return conversation
    .map((m) => {
      const quem = String(m.role).toUpperCase() === 'ASSISTANT' ? 'ATENDIMENTO' : 'LEAD';
      const txt = String(m.content ?? m.body ?? m.text ?? '').replace(/\s+/g, ' ').trim();
      if (!txt) return null;
      const ts = m.at ? ` [${new Date(m.at).toISOString().slice(0, 16).replace('T', ' ')}]` : '';
      return `${quem}${ts}: ${txt}`;
    })
    .filter(Boolean)
    .join('\n');
}

async function classifyConversa({ conversation, examples, stageDefinitions, leadDefinition /*, tenant */ }) {
  const stage = _stageBlock(stageDefinitions);
  const basePrompt = _triageConversaPrompt(leadDefinition);
  return withModelFallback(async (modelName) => {
    const model = client().getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    const convo = _formatConversa(conversation);
    const res = await model.generateContent(
      `${basePrompt}${stage.text}${_fewShot(examples)}\n\nCONVERSA (mais antigo -> mais novo):\n${convo}`
    );
    const parsed = JSON.parse(res.response.text());
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
    const isLead = typeof parsed.is_lead === 'boolean' ? parsed.is_lead : confidence >= 0.5;
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning
      : (typeof parsed.reason === 'string' ? parsed.reason : null);
    // Estado da conversa — na dúvida cai em INDEFINIDO (nunca RESOLVIDO por engano).
    const state = CONVERSA_STATES.includes(parsed.conversation_state) ? parsed.conversation_state : 'INDEFINIDO';
    // Sugestão de etapa: só vale se LEAD e se a key estiver entre as definidas pelo tenant.
    // Saída CATEGÓRICA (key válida ou null) — roteia por ela + reasoning, nunca por banda.
    const suggestedStage = isLead && stage.keys.includes(parsed.suggested_stage)
      ? parsed.suggested_stage : null;
    return {
      is_lead: isLead,
      confidence,
      reasoning,
      intent: CONVERSA_INTENTS.includes(parsed.intent) ? parsed.intent : 'INDEFINIDO',
      conversation_state: state,
      state_reasoning: typeof parsed.state_reasoning === 'string' ? parsed.state_reasoning : null,
      suggested_stage: suggestedStage,
      stage_reasoning: suggestedStage && typeof parsed.stage_reasoning === 'string'
        ? parsed.stage_reasoning : null,
    };
  });
}

// Portão 2 — geração da resposta, com system prompt do tenant + histórico.
// `clarification` (opcional): instrução para repergunta de dado ambíguo (E1-03).
// Intervalo (horas) acima do qual uma retomada pode reabrir com saudação leve —
// como faz a recepcionista de verdade quando o lead some por mais de um dia.
const SAUDACAO_GAP_HORAS = 24;

// Calcula horas desde o último turno do histórico (timestamps `at`); null se não houver.
function _horasDesdeUltimoTurno(history) {
  let ultimo = 0;
  for (const m of history) {
    const t = m && m.at ? new Date(m.at).getTime() : NaN;
    if (Number.isFinite(t) && t > ultimo) ultimo = t;
  }
  if (!ultimo) return null;
  return (Date.now() - ultimo) / 3.6e6;
}

async function generateReply({ systemPrompt, history = [], message, clarification, retomada }) {
  let sys = systemPrompt;
  const primeiroContato = history.length === 0;
  const horas = _horasDesdeUltimoTurno(history);
  // Saudação/apresentação só valem no PRIMEIRO contato ou quando o lead some por um
  // tempo longo (> 1 dia). Em conversa em andamento, nada de cumprimentar/assinar de novo.
  const permitirSaudacao = primeiroContato || (horas != null && horas >= SAUDACAO_GAP_HORAS);
  // RETOMADA: quando JÁ existe conversa anterior (histórico real), a IA não deve tratar
  // como primeiro contato. Condiciona a apresentação/"REFERÊNCIA DE VOZ" do prompt a só
  // valerem sem histórico, e orienta uma retomada contextualizada.
  if (retomada) {
    sys +=
      '\n\nRETOMADA — JÁ EXISTE conversa anterior com esta pessoa (veja o histórico acima). ' +
      'NÃO se apresente de novo (não repita seu nome/função nem a "REFERÊNCIA DE VOZ"). ' +
      'Identifique onde a conversa parou e qual foi o último assunto, referencie isso de forma ' +
      'natural e calorosa, e reconecte avançando para o agendamento da aula experimental. ' +
      'Não invente nada que não foi discutido.' +
      (permitirSaudacao
        ? ' Como faz tempo desde a última mensagem (mais de um dia), você PODE reabrir com um ' +
          'cumprimento leve ("Oi! Tudo bem?") antes de retomar o assunto.'
        : ' A conversa está em andamento (resposta recente): NÃO cumprimente de novo, apenas continue o fluxo.');
  }
  if (clarification) {
    sys += `\n\nNESTA RESPOSTA, peça educadamente que o lead esclareça: ${clarification}.`;
  }
  // Regras de redação: a sugestão deve ENTRAR no fluxo da conversa (não reiniciá-la) e
  // espelhar o tamanho/tom das mensagens recentes. Mantemos imperativo e curto de
  // propósito — frameworks de "análise" longos empurram o modelo para respostas formais
  // e compridas, o oposto do que a recepção precisa.
  sys +=
    '\n\nCOMO ESCREVER A RESPOSTA (você é a própria recepcionista continuando a conversa no WhatsApp):' +
    '\n- ESPELHE o tamanho das mensagens recentes. Se a conversa é de mensagens curtas, responda em UMA frase. Só escreva mais quando o assunto realmente exigir. Na dúvida, seja breve.' +
    '\n- Responda direto ao que a última mensagem pede. Sem rodeios, sem resumir o que já foi dito, sem repetir informação que a pessoa já tem.' +
    '\n- Use o nome do lead no máximo de forma esporádica e natural; jamais em toda mensagem.' +
    '\n- Tom natural de WhatsApp: cordial e humano, espelhando o jeito (formal/informal) das mensagens anteriores. Nada de robótico ou formal demais.' +
    (permitirSaudacao
      ? (primeiroContato
          ? '\n- É a PRIMEIRA mensagem: pode cumprimentar e se apresentar brevemente (uma linha), conforme a referência de voz da escola.'
          : '\n- O lead ficou em silêncio por mais de um dia: um cumprimento leve de reabertura é bem-vindo, sem se reapresentar por completo.')
      : '\n- A conversa está em andamento: NÃO cumprimente ("Olá", "Oi", "Bom dia") nem se apresente de novo, e NUNCA assine com seu nome ou o nome de quem atende ("Atenciosamente", "— Fulana", "Aqui é a Fulana"). A pessoa já está falando com você — apenas continue.');
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

// ─────────────────────────────────────────────────────────────
// Rock Hour (ADR-039) — classificação de gênero restrita ao ACERVO do tenant.
// Aditivo: funções novas, não tocam nada existente. Stateless (não acessa o DB).
//  - classifySongGenres: já tem nome+artista (ex.: botão "sugerir" no manual).
//  - extractAndClassifySongs: recebe TEXTO cru (colado/extraído) → identifica as
//    colunas (qualquer idioma/ordem) E classifica o gênero, numa só chamada.
// Regra: genero/subgenero SEMPRE dentro das listas recebidas; incerto → null.
// ─────────────────────────────────────────────────────────────
function _dentroDoAcervo(valor, permitidos) {
  return Array.isArray(permitidos) && permitidos.includes(valor) ? valor : null;
}
// Tom — lista fechada (cifra). Só aceita um dos 24; senão null (não força).
const _TONS = ['C', 'Cm', 'C#', 'C#m', 'D', 'Dm', 'D#', 'D#m', 'E', 'Em', 'F', 'Fm', 'F#', 'F#m', 'G', 'Gm', 'G#', 'G#m', 'A', 'Am', 'A#', 'A#m', 'B', 'Bm'];
function _tomNaLista(valor) {
  return typeof valor === 'string' && _TONS.includes(valor) ? valor : null;
}

async function classifySongGenres({ musicas = [], generos = [], subgeneros = [] }) {
  if (!musicas.length) return [];
  const prompt = `Classifique o GÊNERO e SUBGÊNERO de cada música.
Escolha ESTRITAMENTE dentro destas listas (nunca fora delas):
- generos: ${JSON.stringify(generos)}
- subgeneros: ${JSON.stringify(subgeneros)}
Se não tiver certeza, retorne null (NÃO invente categoria).
Músicas: ${JSON.stringify(musicas.map((m, i) => ({ ref: m.ref ?? String(i), nome: m.nome, artista: m.artista || null })))}
Responda SOMENTE JSON: {"resultados":[{"ref":"...","genero":str|null,"subgenero":str|null}]}`;
  return withModelFallback(async (modelName) => {
    const model = client().getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: 'application/json', temperature: 0 } });
    const res = await model.generateContent(prompt);
    const parsed = JSON.parse(res.response.text());
    return (parsed.resultados || []).map((r) => ({
      ref: String(r.ref), genero: _dentroDoAcervo(r.genero, generos), subgenero: _dentroDoAcervo(r.subgenero, subgeneros),
    }));
  });
}

async function extractAndClassifySongs({ texto = '', generos = [], subgeneros = [] }) {
  if (!String(texto).trim()) return [];
  const prompt = `Você recebe o DESPEJO de uma planilha em texto (TAB-separado) ou texto de arquivo, em
LAYOUT DESCONHECIDO e QUALQUER idioma. Pode ser orientada a música (1 linha por música), orientada a
ALUNO (1 linha por aluno, com as músicas numa coluna tipo "Músicas Preferidas"), ou texto livre.
Sua tarefa tem DUAS partes: (1) DESCOBRIR a estrutura e EXTRAIR TODAS AS MÚSICAS (nome + artista) que aparecerem, onde quer que estejam;
(2) para CADA música extraída, CLASSIFICAR gênero/subgênero (dentro do acervo) e extrair o tom quando houver coluna.
Regras de extração:
- IGNORE colunas que NÃO são música: nome do aluno, idade, instrumento, banda, telefone, e-mail etc.
  NUNCA transforme nome de aluno / idade / instrumento numa "música".
- Uma célula pode juntar música e artista: "Título - Artista", "Título (Artista)", "Artista: Título" →
  separe em nome e artista. Se não der pra separar com confiança, ponha tudo em nome e deixe artista null (não chute).
- Uma célula ou linha pode listar VÁRIAS músicas (separadas por vírgula, ";", "/", quebra de linha ou numeração) →
  emita UM registro por música.
- Células mescladas: os dados do aluno podem vir em branco nas linhas seguintes — colha as músicas de TODAS as linhas.
- versao (versão/álbum, se houver) e link (url, se houver): preencha só se existirem; senão null.
- Se a primeira linha for cabeçalho (rótulos de coluna, em qualquer idioma), use-a só como REFERÊNCIA das colunas e NÃO a extraia como música.
- tom: SE houver uma coluna de TOM/tonalidade/key na planilha (em qualquer formato/idioma: "C", "Cm", "Dó",
  "Ré menor", "Am", "F#m"…), EXTRAIA e NORMALIZE para a cifra desta lista fechada (os únicos 24 válidos):
  ${JSON.stringify(_TONS)}
  Exemplos: "Dó"→"C", "Ré menor"→"Dm", "Lá menor"/"Am"→"Am", "C#m"→"C#m", "Fá#"→"F#".
  Se o valor não casar com nenhum dos 24, retorne null. NÃO invente nem infira tom que não esteja na planilha —
  se NÃO houver coluna de tom, retorne null em TODAS.
- genero e subgenero: escolha ESTRITAMENTE dentro das listas abaixo; se incerto → null (NÃO invente).
  generos: ${JSON.stringify(generos)}
  subgeneros: ${JSON.stringify(subgeneros)}
NÃO transforme a linha de cabeçalho numa "música".
Responda SOMENTE JSON: {"resultados":[{"nome":str,"artista":str|null,"versao":str|null,"link":str|null,"tom":str|null,"genero":str|null,"subgenero":str|null}]}
Texto:
"""${String(texto).slice(0, 20000)}"""`;
  return withModelFallback(async (modelName) => {
    const model = client().getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: 'application/json', temperature: 0 } });
    const res = await model.generateContent(prompt);
    const parsed = JSON.parse(res.response.text());
    return (parsed.resultados || [])
      .filter((r) => r && r.nome)
      .map((r) => ({
        nome: String(r.nome), artista: r.artista || null, versao: r.versao || null, link: r.link || null,
        tom: _tomNaLista(r.tom),
        genero: _dentroDoAcervo(r.genero, generos), subgenero: _dentroDoAcervo(r.subgenero, subgeneros),
      }));
  });
}

module.exports = {
  classify,
  classifyConversa,
  transcribeAudio,
  generateReply,
  improveReply,
  assistantReply,
  sugestaoRetomada,
  classifyIntent,
  extractQualification,
  classifySongGenres,        // Rock Hour (ADR-039)
  extractAndClassifySongs,   // Rock Hour (ADR-039)
  INTENTS,
  CANDIDATES,
  getActiveModel,
};
