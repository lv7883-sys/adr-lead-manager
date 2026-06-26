'use strict';

// snapshot.js — CONTRATO genérico entre adapter e core do Sincronizador de Recursos
// (ADR-026 §2.1/§2.6). Esta é a ÚNICA forma que cruza a fronteira core↔adapter.
//
// Um ResourceSnapshot descreve o estado da fonte em termos 100% GENÉRICOS — sem
// nenhuma noção da fonte concreta (nomes de endpoint, identificadores ou rótulos do
// sistema de origem, forma do documento bruto). O adapter produz isto; o core
// consome isto. Trocar a fonte (scraping → API → nativo) muda só o adapter; este
// contrato não muda.
//
// Forma:
//   {
//     capabilities: [ { ref: string, name: string } ],
//     resources: [
//       {
//         ref: string,                 // identidade estável na fonte (external_ref)
//         type: 'ROOM' | 'TEACHER' | string,
//         name: string,
//         attributes?: object,         // livre (ex.: vocação de sala) — JSONB no schema
//         capabilityRefs?: string[],   // refs de capabilities deste recurso
//         availability?: [ { weekday: 1..7, start: 'HH:MM', end: 'HH:MM' } ],
//       }
//     ],
//   }

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Valida a forma genérica do snapshot. Lança em violação. */
function validateSnapshot(s) {
  if (!s || typeof s !== 'object') throw new Error('snapshot: objeto esperado');
  if (!Array.isArray(s.capabilities)) throw new Error('snapshot.capabilities: array esperado');
  if (!Array.isArray(s.resources)) throw new Error('snapshot.resources: array esperado');

  const capRefs = new Set();
  for (const c of s.capabilities) {
    if (!c.ref || typeof c.ref !== 'string') throw new Error('capability.ref inválido');
    if (!c.name || typeof c.name !== 'string') throw new Error('capability.name inválido');
    if (capRefs.has(c.ref)) throw new Error(`capability.ref duplicado: ${c.ref}`);
    capRefs.add(c.ref);
  }

  const seen = new Set();
  for (const r of s.resources) {
    if (!r.ref || typeof r.ref !== 'string') throw new Error('resource.ref inválido');
    if (!r.type || typeof r.type !== 'string') throw new Error('resource.type inválido');
    if (!r.name || typeof r.name !== 'string') throw new Error('resource.name inválido');
    const key = `${r.type}|${r.ref}`;
    if (seen.has(key)) throw new Error(`resource (type,ref) duplicado: ${key}`);
    seen.add(key);
    for (const cr of r.capabilityRefs || []) {
      if (!capRefs.has(cr)) throw new Error(`resource ${r.ref} referencia capability inexistente: ${cr}`);
    }
    for (const a of r.availability || []) {
      if (!(a.weekday >= 1 && a.weekday <= 7)) throw new Error(`availability.weekday fora de 1..7: ${a.weekday}`);
      if (!HHMM.test(a.start) || !HHMM.test(a.end)) throw new Error(`availability horário inválido: ${a.start}-${a.end}`);
      if (a.end <= a.start) throw new Error(`availability fim<=início: ${a.start}-${a.end}`);
    }
  }
  return s;
}

module.exports = { validateSnapshot };
