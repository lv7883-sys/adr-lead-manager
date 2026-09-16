'use strict';
const perfil = require('./perfilAssistente');   // perfil da assistente por empresa (ramo, contexto, comportamento, proibidos)

// Template padrão hardcoded (ponto de partida: Academia do Rock).
// Usado quando tenant_lead_config.system_prompt_override é null.
// Variáveis suportadas: {{school_name}}, {{instruments}}, {{business_hours}}.
const DEFAULT_SYSTEM_PROMPT = `Você é o assistente virtual da {{school_name}}, uma escola de música.

Seu papel é atender pelo WhatsApp pessoas interessadas em aulas, com tom
acolhedor, animado e próprio de quem respira música. Responda sempre em
português do Brasil, de forma objetiva e simpática.

Horário de atendimento: {{business_hours}}.

Diretrizes:
- Tire dúvidas sobre instrumentos, planos e horários.
- Sempre que fizer sentido, convide a pessoa para uma aula experimental gratuita.
- Não invente valores ou condições que você não conhece; ofereça encaminhar
  para um atendente humano quando necessário.
- Se a pessoa demonstrar interesse real, procure descobrir, de forma natural,
  o nome dela, o instrumento de interesse e a disponibilidade de horário.
- Se a mensagem fugir do tema de aulas/escola de música (assunto fora do
  escopo), NÃO tente resolver o assunto: redirecione a pessoa educadamente
  para um atendente humano.`;

// Template padrão para QUALQUER ramo (usado quando a empresa configurou ramo ou objetivo no perfil da
// assistente e não tem prompt próprio). O que é específico do negócio vem do perfil (perfilAssistente.js).
const GENERIC_SYSTEM_PROMPT = `Você é a assistente virtual da {{school_name}}, {{empresa}}.

Seu papel é atender pelo WhatsApp as pessoas que entram em contato, com tom
cordial e humano. Responda sempre em português do Brasil, de forma objetiva e simpática.

Horário de atendimento: {{business_hours}}.

Diretrizes:
- Tire dúvidas sobre o que a empresa oferece usando só as informações deste prompt.
- Não invente valores, prazos ou condições que você não conhece; ofereça encaminhar
  para um atendente humano quando necessário.
- Se a pessoa demonstrar interesse real, descubra de forma natural o que ela precisa
  e conduza para o objetivo das conversas definido pela empresa.
- Se a mensagem fugir do que a empresa faz, NÃO tente resolver o assunto: redirecione
  a pessoa educadamente para um atendente humano.`;

const DAY_LABELS = {
  mon: 'Seg',
  tue: 'Ter',
  wed: 'Qua',
  thu: 'Qui',
  fri: 'Sex',
  sat: 'Sáb',
  sun: 'Dom',
};
const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// Converte { mon: "09:00-18:00", ... } em texto legível para o prompt.
function formatBusinessHours(businessHours) {
  const entries = DAY_ORDER.filter((d) => businessHours && businessHours[d]).map((d) => {
    const v = businessHours[d];
    return `${DAY_LABELS[d]}: ${v === 'closed' ? 'fechado' : v}`;
  });
  return entries.length ? entries.join(', ') : 'não informado';
}

// CURSOS E AULAS OFERECIDOS — a lista oficial da unidade (tenant_lead_config.available_instruments),
// editada na tela Configurações de Leads. Genérica de propósito: numa escola de música são
// instrumentos; noutra empresa podem ser modalidades, serviços etc.
//
// Por que vira um bloco próprio, anexado a QUALQUER prompt (inclusive o override da unidade): o
// override é texto livre escrito uma vez e não acompanha a escola — quando Valinhos abriu violino e
// gaita, a Janis seguia sem saber, porque a lista só entrava no template padrão (que Valinhos não
// usa). Agora a lista configurada chega em toda resposta: sugestão, estratégia, retomada.
const MAX_CURSOS = 60;
const MAX_CURSO_CHARS = 60;
function normalizarCursos(lista) {
  if (!Array.isArray(lista)) return [];
  const vistos = new Set();
  const out = [];
  for (const item of lista) {
    const nome = String(item == null ? '' : item).replace(/\s+/g, ' ').trim().slice(0, MAX_CURSO_CHARS);
    if (!nome) continue;
    const chave = nome.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();   // "Violão" = "violao"
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    out.push(nome);
    if (out.length >= MAX_CURSOS) break;
  }
  return out;
}

function blocoCursos(config) {
  const cursos = normalizarCursos(config && config.available_instruments);
  if (!cursos.length) return '';
  return '\n\nO QUE A EMPRESA OFERECE — cursos, aulas, produtos ou serviços (lista oficial e atual — vale mais do que qualquer outra ' +
    'menção a isso neste texto ou no histórico da conversa): ' + cursos.join(', ') + '.' +
    '\n- Quando perguntarem se a empresa tem determinado curso, produto ou serviço, responda com base nesta lista.' +
    '\n- Se perguntarem por algo que NÃO está na lista, não afirme que tem nem que não tem: diga que vai confirmar com a equipe.';
}

function renderDefaultPrompt(config) {
  const cursos = normalizarCursos(config.available_instruments);
  const hours = formatBusinessHours(config.business_hours || {});
  const base = perfil.generico(config.perfil) ? GENERIC_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT;
  return base.replaceAll('{{school_name}}', config.school_name || '')
    .replaceAll('{{empresa}}', perfil.descricaoEmpresa(config.perfil))
    .replaceAll('{{instruments}}', cursos.length ? cursos.join(', ') : 'diversos instrumentos')
    .replaceAll('{{business_hours}}', hours) + blocoCursos(config) + perfil.blocoPerfil(config.perfil);
}

// Prompt efetivo: usa o override se houver; senão, renderiza o template padrão. Nos dois casos entram no
// final o que a empresa oferece e o PERFIL DA ASSISTENTE (contexto, comportamento, assuntos proibidos).
// `config.perfil` vem do fragmento SQL_PERFIL (automacao_config); sem ele, nada muda.
function resolveSystemPrompt(config) {
  if (config.system_prompt_override != null && config.system_prompt_override !== '') {
    return config.system_prompt_override + blocoCursos(config) + perfil.blocoPerfil(config.perfil);
  }
  return renderDefaultPrompt(config);
}

module.exports = {
  DEFAULT_SYSTEM_PROMPT,
  GENERIC_SYSTEM_PROMPT,
  blocoCursos,
  normalizarCursos,
  formatBusinessHours,
  renderDefaultPrompt,
  resolveSystemPrompt,
};
