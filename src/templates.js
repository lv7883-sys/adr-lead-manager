'use strict';

// Template padrão hardcoded (ponto de partida: Academia do Rock).
// Usado quando tenant_lead_config.system_prompt_override é null.
// Variáveis suportadas: {{school_name}}, {{instruments}}, {{business_hours}}.
const DEFAULT_SYSTEM_PROMPT = `Você é o assistente virtual da {{school_name}}, uma escola de música.

Seu papel é atender pelo WhatsApp pessoas interessadas em aulas, com tom
acolhedor, animado e próprio de quem respira música. Responda sempre em
português do Brasil, de forma objetiva e simpática.

Instrumentos disponíveis para aulas: {{instruments}}.
Horário de atendimento: {{business_hours}}.

Diretrizes:
- Tire dúvidas sobre instrumentos, planos e horários.
- Sempre que fizer sentido, convide a pessoa para uma aula experimental gratuita.
- Não invente valores ou condições que você não conhece; ofereça encaminhar
  para um atendente humano quando necessário.
- Se a pessoa demonstrar interesse real, colete nome e instrumento desejado.`;

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

function renderDefaultPrompt(config) {
  const instruments =
    Array.isArray(config.available_instruments) && config.available_instruments.length
      ? config.available_instruments.join(', ')
      : 'diversos instrumentos';
  const hours = formatBusinessHours(config.business_hours || {});
  return DEFAULT_SYSTEM_PROMPT.replaceAll('{{school_name}}', config.school_name || '')
    .replaceAll('{{instruments}}', instruments)
    .replaceAll('{{business_hours}}', hours);
}

// Prompt efetivo: usa o override se houver; senão, renderiza o template padrão.
function resolveSystemPrompt(config) {
  if (config.system_prompt_override != null && config.system_prompt_override !== '') {
    return config.system_prompt_override;
  }
  return renderDefaultPrompt(config);
}

module.exports = {
  DEFAULT_SYSTEM_PROMPT,
  formatBusinessHours,
  renderDefaultPrompt,
  resolveSystemPrompt,
};
