'use strict';
//
// promptConfig.js — carrega a config que alimenta o prompt da IA a partir das
// FONTES ÚNICAS de cada informação. Em especial, o HORÁRIO DE ATENDIMENTO vem
// SEMPRE de tenants.horario_comercial (a aba "Horário de atendimento") — nunca
// mais de tenant_lead_config.business_hours (coluna descontinuada). Centralizar
// aqui garante que nenhum consumidor do prompt leia horário de outro lugar.
//
const { textoHorario } = require('./horario');

// jsonb da aba tem prioridade; o trio legado (029) só entra como fallback de
// transição — mesma regra do GET /tenant/:id/horario-comercial.
function horarioFonte(t) {
  if (t && t.horario_comercial && typeof t.horario_comercial === 'object'
      && !Array.isArray(t.horario_comercial) && Object.keys(t.horario_comercial).length) {
    return t.horario_comercial;
  }
  if (t && t.hc_inicio && t.hc_fim && Array.isArray(t.hc_dias) && t.hc_dias.length) {
    return { inicio: t.hc_inicio, fim: t.hc_fim, dias: t.hc_dias };
  }
  return null;
}

// `c` = client já dentro de withTenant(tenantId). Retorna o objeto aceito por
// resolveSystemPrompt: { school_name, system_prompt_override, available_instruments,
//   notification_whatsapp, tname, horario_texto }.
async function loadPromptConfig(c, tenantId) {
  const cfg = (await c.query(
    `SELECT school_name, system_prompt_override, available_instruments, notification_whatsapp
       FROM tenant_lead_config WHERE tenant_id = $1`, [tenantId])).rows[0];
  const t = (await c.query(
    `SELECT name, horario_comercial,
            to_char(horario_comercial_inicio, 'HH24:MI') AS hc_inicio,
            to_char(horario_comercial_fim, 'HH24:MI') AS hc_fim,
            horario_comercial_dias AS hc_dias
       FROM tenants WHERE id = $1`, [tenantId])).rows[0] || {};
  return {
    school_name: (cfg && cfg.school_name) || t.name || 'Escola',
    system_prompt_override: (cfg && cfg.system_prompt_override) || null,
    available_instruments: (cfg && cfg.available_instruments) || [],
    notification_whatsapp: (cfg && cfg.notification_whatsapp) || null,
    tname: t.name || null,
    horario_texto: textoHorario(horarioFonte(t)),
  };
}

module.exports = { loadPromptConfig, horarioFonte };
