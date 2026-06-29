'use strict';

// grade.js — VÃOS LIVRES RECORRENTES (semana-tipo) por capability. Fatia da grade de
// disponibilidade (ADR-025/026). SÓ LEITURA: cruza professores (TEACHER) compatíveis com a
// capability e sua disponibilidade RECORRENTE (resource_availability) ↔ as salas (ROOM)
// compatíveis com a capability.
//
// FÓRMULA (Frente A): disponibilidade = expediente − ocupação. O vão livre, por weekday, é:
//   professor compatível DISPONÍVEL e NÃO-ocupado  ∩  sala compatível NÃO-ocupada  ∩  expediente.
//
// SALA: não tem agenda própria (a Extranet só dá horário de PROFESSOR); por desenho ela conta
// livre em TODO o expediente do weekday — MENOS onde occupation_history a marca ocupada. A
// ocupação (de prof E de sala) entra como INTERVALOS [slot_time, slot_end) já resolvidos em
// minutos (o legado slot_end NULL vira fallback de 60min na rota, não aqui). profs_livres /
// salas_livres por subvão passam a descontar a ocupação real dos dois lados.
//
// Devolve INTERVALOS CONTÍNUOS crus [inicio,fim) — NÃO fatia em células de duração. O front
// é quem fatia/arrasta (1h / 1,5h). Fora do expediente nunca é vão, mesmo com professor livre.
// Nada de Extranet aqui — o termo recorrente + a ocupação já estão no banco.

// 'HH:MM[:SS]' → minutos do dia (node-pg devolve `time` como string).
const toMin = (t) => {
  const [h, m] = String(t).split(':');
  return Number(h) * 60 + Number(m);
};
// minutos → 'HH:MM'.
const hhmm = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Funde intervalos sobrepostos OU encostados (fim==início vira contínuo). Entrada/saída
// em minutos. Retorna lista ordenada e disjunta de {start,end}.
function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = out[out.length - 1];
    if (sorted[i].start <= cur.end) cur.end = Math.max(cur.end, sorted[i].end);
    else out.push({ start: sorted[i].start, end: sorted[i].end });
  }
  return out;
}

// Interseção de duas listas de intervalos já fundidas (cobertura simultânea). Two-pointer.
function intersectLists(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (start < end) out.push({ start, end });
    if (a[i].end < b[j].end) i++; else j++;
  }
  return out;
}

/**
 * computeVaos — vãos livres recorrentes por weekday, DESCONTANDO ocupação. Função PURA (sem IO).
 *
 * @param {Array<{id:string,
 *                avail:Array<{weekday:number,start:number,end:number}>,
 *                ocup?:Array<{weekday:number,start:number,end:number}>}>} professores
 *   - avail: disponibilidade recorrente (resource_availability). ocup: ocupação vigente
 *     (occupation_history), intervalos [start,end) em MINUTOS já resolvidos.
 * @param {Array<{id:string, ocup?:Array<{weekday:number,start:number,end:number}>}>} salas
 *   - salas compatíveis SELECIONADAS (lista, não contagem). Cada sala é livre em todo o
 *     expediente MENOS onde sua ocup a cobre. < 1 sala → sem lugar físico → 0 vãos.
 * @param {Map<number, Array<{start:number,end:number}>>} expediente
 *   - por weekday (ISO 1=seg..7=dom), faixas do horário de atendimento em MINUTOS.
 * @returns {{ vaos: Array<{weekday:number,inicio:string,fim:string,profs_livres:number,salas_livres:number}>,
 *             janela: {weekday_min:number|null, weekday_max:number|null, hora_min:string|null, hora_max:string|null} }}
 *
 * FOLGA = CONCORRÊNCIA REAL dos dois lados. Sweep line por weekday nos pontos onde QUALQUER
 * contagem muda: start/end de disponibilidade de prof, de ocupação de prof, de ocupação de sala,
 * e abre/fecha do expediente. Cada SUBVÃO entre dois pontos tem profs_livres / salas_livres
 * CONSTANTES. profs_livres = profs DISPONÍVEIS e NÃO-ocupados ali; salas_livres = salas
 * compatíveis NÃO-ocupadas ali. Só emitimos onde ambos >= 1 E o subvão está DENTRO do expediente.
 */
function computeVaos(professores, salas = [], expediente = new Map()) {
  if (!(expediente instanceof Map)) expediente = new Map();
  const emptyJanela = { weekday_min: null, weekday_max: null, hora_min: null, hora_max: null };
  const salasCount = salas.length;

  // Sem sala compatível → sem lugar físico → nunca há vão (independe de professor).
  if (salasCount < 1) return { vaos: [], janela: emptyJanela };

  // Índices por weekday → [{id,start,end}].
  const byDay = (acc, weekday, item) => { if (!acc.has(weekday)) acc.set(weekday, []); acc.get(weekday).push(item); };
  const profAvailByDay = new Map();  // disponibilidade de professor
  const profOcupByDay = new Map();   // ocupação de professor
  const salaOcupByDay = new Map();   // ocupação de sala
  for (const p of professores) {
    for (const a of (p.avail || [])) byDay(profAvailByDay, a.weekday, { id: p.id, start: a.start, end: a.end });
    for (const o of (p.ocup || [])) byDay(profOcupByDay, o.weekday, { id: p.id, start: o.start, end: o.end });
  }
  for (const s of salas) for (const o of (s.ocup || [])) byDay(salaOcupByDay, o.weekday, { id: s.id, start: o.start, end: o.end });

  // janela (eixos) = moldura do EXPEDIENTE do tenant. Independe de prof/ocupação: é o frame de
  // horário comercial que o front desenha a semana.
  let wkMin = Infinity, wkMax = -Infinity, horaMin = Infinity, horaMax = -Infinity;
  for (const [weekday, faixas] of expediente) {
    for (const f of faixas) {
      wkMin = Math.min(wkMin, weekday); wkMax = Math.max(wkMax, weekday);
      horaMin = Math.min(horaMin, f.start); horaMax = Math.max(horaMax, f.end);
    }
  }

  const vaos = [];
  // dias candidatos = onde há disponibilidade de professor (sem prof disponível, nunca há vão).
  for (const weekday of [...profAvailByDay.keys()].sort((a, b) => a - b)) {
    const avail = profAvailByDay.get(weekday) || [];
    const exp = expediente.get(weekday) || [];
    if (!avail.length || !exp.length) continue; // dia fechado OU sem professor → sem vão
    const profOcup = profOcupByDay.get(weekday) || [];
    const salaOcup = salaOcupByDay.get(weekday) || [];

    // Sweep line: fronteiras = todos os start/end (avail ∪ ocup-prof ∪ ocup-sala ∪ expediente).
    // Entre duas fronteiras a cobertura é constante: cada intervalo cobre o subvão inteiro
    // (start <= p0 && end >= p1) ou não o toca.
    const bounds = [...new Set(
      [...avail, ...profOcup, ...salaOcup, ...exp].flatMap((iv) => [iv.start, iv.end]))].sort((a, b) => a - b);
    for (let k = 0; k + 1 < bounds.length; k++) {
      const p0 = bounds[k], p1 = bounds[k + 1];
      if (!exp.some((f) => f.start <= p0 && f.end >= p1)) continue; // fora do expediente → não é vão

      // professores LIVRES = disponíveis aqui E não-ocupados aqui.
      const profsLivres = new Set();
      for (const iv of avail) if (iv.start <= p0 && iv.end >= p1) profsLivres.add(iv.id);
      if (profsLivres.size === 0) continue;
      for (const iv of profOcup) if (iv.start <= p0 && iv.end >= p1) profsLivres.delete(iv.id);
      if (profsLivres.size === 0) continue;

      // salas LIVRES = total selecionado − salas ocupadas aqui.
      const salasOcupadas = new Set();
      for (const iv of salaOcup) if (iv.start <= p0 && iv.end >= p1) salasOcupadas.add(iv.id);
      const salasLivres = salasCount - salasOcupadas.size;
      if (salasLivres < 1) continue;

      vaos.push({
        weekday,
        inicio: hhmm(p0),
        fim: hhmm(p1),
        profs_livres: profsLivres.size,
        salas_livres: salasLivres,
      });
    }
  }

  const janela = wkMin !== Infinity
    ? { weekday_min: wkMin, weekday_max: wkMax, hora_min: hhmm(horaMin), hora_max: hhmm(horaMax) }
    : emptyJanela;

  return { vaos, janela };
}

module.exports = { computeVaos, mergeIntervals, intersectLists, toMin, hhmm };
