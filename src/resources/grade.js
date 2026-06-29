'use strict';

// grade.js — VÃOS LIVRES RECORRENTES (semana-tipo) por capability. Fatia da grade de
// disponibilidade (ADR-025/026). SÓ LEITURA: cruza professores (TEACHER) ↔ salas (ROOM)
// compatíveis com a capability e sua disponibilidade RECORRENTE (resource_availability).
//
// Devolve INTERVALOS CONTÍNUOS crus [inicio,fim) — NÃO fatia em células de duração. O front
// é quem fatia/arrasta (1h / 1,5h). O vão livre, por weekday, é a INTERSEÇÃO entre a UNIÃO
// dos intervalos dos professores e a UNIÃO dos intervalos das salas (onde as duas coberturas
// existem ao mesmo tempo). Nada de Extranet aqui — o termo recorrente já está no banco.

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
 * computeVaos — vãos livres recorrentes por weekday. Função PURA (sem IO).
 *
 * @param {Array<{id:string, avail:Array<{weekday:number,start:number,end:number}>}>} professores
 * @param {Array<{id:string, avail:Array<{weekday:number,start:number,end:number}>}>} salas
 *   (start/end em MINUTOS do dia)
 * @returns {{ vaos: Array<{weekday:number,inicio:string,fim:string,profs_livres:number,salas_livres:number}>,
 *             janela: {weekday_min:number|null, weekday_max:number|null, hora_min:string|null, hora_max:string|null} }}
 *
 * FOLGA = CONCORRÊNCIA REAL. O dia é varrido (sweep line) nos pontos onde a contagem de
 * professores OU de salas livres muda (os start/end de cada resource_availability dos recursos
 * selecionados). Cada SUBVÃO entre dois pontos consecutivos tem profs_livres / salas_livres
 * CONSTANTES e reais naquele trecho; só emitimos onde ambos >= 1. NÃO re-fundimos subvãos
 * adjacentes — o dado é fiel ponto a ponto (o front decide a pintura). Ex.: se um prof sai às
 * 09h, "08:00-12:00 (2/2)" vira "08:00-09:00 (2/2)" + "09:00-12:00 (1/2)".
 */
function computeVaos(professores, salas) {
  // weekday → { prof:[{id,start,end}], sala:[...] }
  const byDay = new Map();
  const collect = (list, key) => {
    for (const r of list) {
      for (const a of r.avail) {
        if (!byDay.has(a.weekday)) byDay.set(a.weekday, { prof: [], sala: [] });
        byDay.get(a.weekday)[key].push({ id: r.id, start: a.start, end: a.end });
      }
    }
  };
  collect(professores, 'prof');
  collect(salas, 'sala');

  const vaos = [];
  let wkMin = Infinity, wkMax = -Infinity, horaMin = Infinity, horaMax = -Infinity;

  for (const [weekday, di] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    // extent p/ a janela (eixos) = TODA a disponibilidade selecionada nesse weekday.
    for (const iv of [...di.prof, ...di.sala]) {
      wkMin = Math.min(wkMin, weekday); wkMax = Math.max(wkMax, weekday);
      horaMin = Math.min(horaMin, iv.start); horaMax = Math.max(horaMax, iv.end);
    }
    if (!di.prof.length || !di.sala.length) continue; // precisa dos dois lados

    // Sweep line: fronteiras = todos os start/end (prof ∪ sala), ordenados e únicos. Entre
    // duas fronteiras consecutivas a cobertura é constante, então cada intervalo iv ou cobre
    // o subvão inteiro (iv.start <= p0 && iv.end >= p1) ou não o toca.
    const bounds = [...new Set([...di.prof, ...di.sala].flatMap((iv) => [iv.start, iv.end]))].sort((a, b) => a - b);
    for (let k = 0; k + 1 < bounds.length; k++) {
      const p0 = bounds[k], p1 = bounds[k + 1];
      const profs = new Set();
      for (const iv of di.prof) if (iv.start <= p0 && iv.end >= p1) profs.add(iv.id);
      if (profs.size === 0) continue;
      const salasLivres = new Set();
      for (const iv of di.sala) if (iv.start <= p0 && iv.end >= p1) salasLivres.add(iv.id);
      if (salasLivres.size === 0) continue;
      vaos.push({
        weekday,
        inicio: hhmm(p0),
        fim: hhmm(p1),
        profs_livres: profs.size,
        salas_livres: salasLivres.size,
      });
    }
  }

  const janela = byDay.size
    ? { weekday_min: wkMin, weekday_max: wkMax, hora_min: hhmm(horaMin), hora_max: hhmm(horaMax) }
    : { weekday_min: null, weekday_max: null, hora_min: null, hora_max: null };

  return { vaos, janela };
}

module.exports = { computeVaos, mergeIntervals, intersectLists, toMin, hhmm };
