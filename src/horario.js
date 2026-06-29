'use strict';
//
// horario.js — fonte ÚNICA do "horário de atendimento" e da pergunta
// canônica "está no expediente?".
//
// Estrutura canônica (jsonb da coluna tenants.horario_comercial):
//   { "1":[{"inicio":"09:00","fim":"22:00"}], "6":[{"inicio":"09:00","fim":"13:00"}], ... }
//   - chave = dia ISO 1=seg..7=dom; dia AUSENTE = fechado; lista vazia = fechado.
//   - múltiplas faixas/dia permitidas (intervalo de almoço); [inicio,fim) fim exclusivo.
//
// Fuso de São Paulo (UTC-3, sem horário de verão) centralizado AQUI — não
// deve ser duplicado por nenhum consumidor.
//

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// timestamp → { mins: minuto-do-dia, isoDow: 1=seg..7=dom } no fuso SP.
function spMinDow(ts) {
  const x = new Date(new Date(ts).getTime() - 3 * 3600 * 1000);
  return { mins: x.getUTCHours() * 60 + x.getUTCMinutes(), isoDow: x.getUTCDay() === 0 ? 7 : x.getUTCDay() };
}

// 'HH:MM' (ou 'HH:MM:SS') → minuto-do-dia.
function hmToMin(t) {
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
// minuto-do-dia → 'HH:MM'.
function minToHm(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Converte o trio legado { inicio, fim, dias[] } → estrutura por-dia canônica.
// inicio/fim podem ser 'HH:MM' ou 'HH:MM:SS' (coluna time); cada dia marcado
// recebe a MESMA faixa única. Usado no fallback de tenants sem o jsonb ainda.
function fromLegacy(inicio, fim, dias) {
  if (!inicio || !fim || !Array.isArray(dias) || !dias.length) return null;
  const i = String(inicio).slice(0, 5), f = String(fim).slice(0, 5);
  const out = {};
  for (const d of dias) {
    const k = String(Number(d));
    if (Number(k) >= 1 && Number(k) <= 7) out[k] = [{ inicio: i, fim: f }];
  }
  return Object.keys(out).length ? out : null;
}

// Normaliza qualquer entrada para um mapa { isoDow: [{ini:min, fim:min}] } com
// minutos (forma interna p/ comparação). Aceita:
//   - o jsonb novo  { "1":[{inicio,fim}], ... }
//   - o objeto legado { inicio, fim, dias[] }  (fallback retrocompat)
//   - null / vazio → null (sem expediente configurado).
// Faixas inválidas são ignoradas (defensivo); não lança.
function normaliza(input) {
  if (!input || typeof input !== 'object') return null;
  let porDia = input;
  // Detecta o shape legado e converte primeiro.
  if (Array.isArray(input.dias) || 'inicio' in input || 'fim' in input) {
    porDia = fromLegacy(input.inicio, input.fim, input.dias);
    if (!porDia) return null;
  }
  const out = {};
  for (let d = 1; d <= 7; d++) {
    const faixas = porDia[String(d)];
    if (!Array.isArray(faixas) || !faixas.length) continue;
    const norm = [];
    for (const fx of faixas) {
      if (!fx || !HM_RE.test(String(fx.inicio)) || !HM_RE.test(String(fx.fim))) continue;
      const ini = hmToMin(fx.inicio), fim = hmToMin(fx.fim);
      if (ini < fim) norm.push({ ini, fim });
    }
    if (norm.length) out[d] = norm.sort((a, b) => a.ini - b.ini);
  }
  return Object.keys(out).length ? out : null;
}

// Pergunta canônica: o timestamp caiu dentro do expediente?
//   true  = dentro de alguma faixa do dia (no fuso SP)
//   false = fora / dia fechado
//   null  = sem timestamp ou sem horário configurado
// `horario` = o jsonb novo OU o objeto legado {inicio,fim,dias} (fallback).
function dentroDoExpediente(horario, ts) {
  if (!ts) return null;
  const norm = normaliza(horario);
  if (!norm) return null;
  const { mins, isoDow } = spMinDow(ts);
  const faixas = norm[isoDow];
  if (!faixas) return false;
  for (const f of faixas) if (mins >= f.ini && mins < f.fim) return true;
  return false;
}

// Faixas de um weekday (ISO 1=seg..7=dom) como [{inicio:'HH:MM', fim:'HH:MM'}],
// ordenadas. Vazio = dia fechado. Para a grade montar a moldura do dia.
function faixasDoDia(horario, weekday) {
  const norm = normaliza(horario);
  if (!norm) return [];
  const faixas = norm[Number(weekday)];
  if (!faixas) return [];
  return faixas.map((f) => ({ inicio: minToHm(f.ini), fim: minToHm(f.fim) }));
}

// Valida o shape por-dia vindo do PUT. Retorna { ok:true } ou { ok:false, error }.
// Regras: chaves 1..7; cada faixa {inicio,fim} HH:MM; inicio<fim; faixas do
// MESMO dia não se sobrepõem. Objeto vazio (tudo fechado) é válido.
function validaHorarioJson(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'horário inválido' };
  for (const k of Object.keys(obj)) {
    const d = Number(k);
    if (!Number.isInteger(d) || d < 1 || d > 7) return { ok: false, error: `dia inválido: ${k} (use 1..7)` };
    const faixas = obj[k];
    if (!Array.isArray(faixas)) return { ok: false, error: `dia ${k}: faixas devem ser uma lista` };
    const ordenadas = [];
    for (const fx of faixas) {
      if (!fx || !HM_RE.test(String(fx.inicio)) || !HM_RE.test(String(fx.fim))) {
        return { ok: false, error: `dia ${k}: faixa inválida (use HH:MM)` };
      }
      const ini = hmToMin(fx.inicio), fim = hmToMin(fx.fim);
      if (ini >= fim) return { ok: false, error: `dia ${k}: início deve ser antes do fim` };
      ordenadas.push({ ini, fim });
    }
    ordenadas.sort((a, b) => a.ini - b.ini);
    for (let i = 1; i < ordenadas.length; i++) {
      if (ordenadas[i].ini < ordenadas[i - 1].fim) {
        return { ok: false, error: `dia ${k}: faixas se sobrepõem` };
      }
    }
  }
  return { ok: true };
}

// Reduz o jsonb por-dia para a estrutura canônica enxuta (descarta faixas
// inválidas, ordena, remove dias vazios). Use antes de gravar.
function canonicaliza(obj) {
  const norm = normaliza(obj);
  if (!norm) return {};
  const out = {};
  for (const d of Object.keys(norm)) {
    out[d] = norm[d].map((f) => ({ inicio: minToHm(f.ini), fim: minToHm(f.fim) }));
  }
  return out;
}

module.exports = {
  dentroDoExpediente,
  faixasDoDia,
  fromLegacy,
  normaliza,
  validaHorarioJson,
  canonicaliza,
  spMinDow,
  minToHm,
};
