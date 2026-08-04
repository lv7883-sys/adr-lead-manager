'use strict';

// Template padrão hardcoded (ponto de partida: Academia do Rock).
// Usado quando tenant_lead_config.system_prompt_override é null.
// Variáveis suportadas: {{school_name}}, {{instruments}}, {{horario_atendimento}}.
// O horário vem SEMPRE de config.horario_texto (fonte única tenants.horario_comercial,
// a aba "Horário de atendimento") — ver promptConfig.loadPromptConfig.
const DEFAULT_SYSTEM_PROMPT = `Você é o assistente virtual da {{school_name}}, uma escola de música.

Seu papel é atender pelo WhatsApp pessoas interessadas em aulas, com tom
acolhedor, animado e próprio de quem respira música. Responda sempre em
português do Brasil, de forma objetiva e simpática.

Instrumentos disponíveis para aulas: {{instruments}}.
Horário de atendimento: {{horario_atendimento}}.

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

function renderDefaultPrompt(config) {
  const instruments =
    Array.isArray(config.available_instruments) && config.available_instruments.length
      ? config.available_instruments.join(', ')
      : 'diversos instrumentos';
  // Horário: fonte única (config.horario_texto, já renderizado de tenants.horario_comercial).
  const hours = (config.horario_texto != null && config.horario_texto !== '')
    ? config.horario_texto
    : 'não informado';
  return DEFAULT_SYSTEM_PROMPT.replaceAll('{{school_name}}', config.school_name || '')
    .replaceAll('{{instruments}}', instruments)
    .replaceAll('{{horario_atendimento}}', hours);
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
  renderDefaultPrompt,
  resolveSystemPrompt,
};
