'use strict';

// grade.js — VÃOS LIVRES RECORRENTES (semana-tipo) por capability. Fatia da grade de
// disponibilidade (ADR-025/026). SÓ LEITURA: cruza professores (TEACHER) compatíveis com a
// capability e sua disponibilidade RECORRENTE (resource_availability) ↔ as salas (ROOM)
// compatíveis com a capability.
//
// IMPORTANTE: a SALA não tem agenda própria. A Extranet só fornece horário de PROFESSOR;
// salas nunca têm linhas em resource_availability. Por desenho, a disponibilidade recorrente
// da sala = o EXPEDIENTE do tenant (horário de atendimento por-dia, de src/horario.js). A
// sala compatível conta como livre em TODO o expediente do weekday; a ocupação real só aparece
// no ao-vivo. Logo o lado "sala" aqui é: (1) quantas salas compatíveis existem (≥1 obrigatório,
// senão não há lugar físico → 0 vãos) e (2) a moldura do expediente daquele dia.
//
// Devolve INTERVALOS CONTÍNUOS crus [inicio,fim) — NÃO fatia em células de duração. O front
// é quem fatia/arrasta (1h / 1,5h). O vão livre, por weekday, é a disponibilidade dos
// professores INTERSECTADA com as faixas do expediente do tenant naquele dia (fora do
// expediente nunca é vão, mesmo com professor livre). Nada de Extranet aqui.

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
 *   (start/end em MINUTOS do dia)
 * @param {{ salasCount:number,
 *           expediente:Map<number, Array<{start:number,end:number}>> }} opts
 *   - salasCount: nº de salas compatíveis SELECIONADAS (a sala não tem agenda própria; ver
 *     cabeçalho). < 1 → sem lugar físico → 0 vãos.
 *   - expediente: por weekday (ISO 1=seg..7=dom), as faixas do horário de atendimento do tenant
 *     em MINUTOS do dia. Weekday ausente / vazio = fechado. A sala conta livre em toda faixa.
 * @returns {{ vaos: Array<{weekday:number,inicio:string,fim:string,profs_livres:number,salas_livres:number}>,
 *             janela: {weekday_min:number|null, weekday_max:number|null, hora_min:string|null, hora_max:string|null} }}
 *
 * FOLGA = CONCORRÊNCIA REAL dos professores. O dia é varrido (sweep line) nos pontos onde a
 * contagem de professores livres muda (start/end de cada resource_availability) OU onde o
 * expediente abre/fecha. Cada SUBVÃO entre dois pontos consecutivos tem profs_livres CONSTANTE;
 * só emitimos onde profs_livres >= 1 E o subvão está DENTRO do expediente (a sala cobre todo o
 * expediente, então salas_livres = salasCount, constante no recorrente). Fora do expediente
 * nunca é vão, mesmo com professor livre. NÃO re-fundimos subvãos adjacentes — o dado é fiel
 * ponto a ponto (o front decide a pintura).
 */
function computeVaos(professores, opts = {}) {
  const salasCount = Number(opts.salasCount) || 0;
  const expediente = opts.expediente instanceof Map ? opts.expediente : new Map();
  const emptyJanela = { weekday_min: null, weekday_max: null, hora_min: null, hora_max: null };

  // Sem sala compatível → sem lugar físico → nunca há vão (independe de professor).
  if (salasCount < 1) return { vaos: [], janela: emptyJanela };

  // weekday → [{id,start,end}] só dos professores (a sala = moldura do expediente).
  const profByDay = new Map();
  for (const r of professores) {
    for (const a of r.avail) {
      if (!profByDay.has(a.weekday)) profByDay.set(a.weekday, []);
      profByDay.get(a.weekday).push({ id: r.id, start: a.start, end: a.end });
    }
  }

  // janela (eixos) = moldura do EXPEDIENTE do tenant (a sala cobre todo o expediente). Independe
  // de haver professor no dia: é o frame de horário comercial que o front desenha a semana.
  let wkMin = Infinity, wkMax = -Infinity, horaMin = Infinity, horaMax = -Infinity;
  for (const [weekday, faixas] of expediente) {
    for (const f of faixas) {
      wkMin = Math.min(wkMin, weekday); wkMax = Math.max(wkMax, weekday);
      horaMin = Math.min(horaMin, f.start); horaMax = Math.max(horaMax, f.end);
    }
  }

  const vaos = [];
  for (const weekday of [...profByDay.keys()].sort((a, b) => a - b)) {
    const profIvs = profByDay.get(weekday);
    const exp = expediente.get(weekday) || [];
    if (!profIvs.length || !exp.length) continue; // dia fechado OU sem professor → sem vão

    // Sweep line: fronteiras = start/end dos professores ∪ start/end do expediente, ordenados e
    // únicos. Entre duas fronteiras a cobertura é constante: cada intervalo cobre o subvão
    // inteiro (start <= p0 && end >= p1) ou não o toca.
    const bounds = [...new Set([...profIvs, ...exp].flatMap((iv) => [iv.start, iv.end]))].sort((a, b) => a - b);
    for (let k = 0; k + 1 < bounds.length; k++) {
      const p0 = bounds[k], p1 = bounds[k + 1];
      if (!exp.some((f) => f.start <= p0 && f.end >= p1)) continue; // fora do expediente → não é vão
      const profs = new Set();
      for (const iv of profIvs) if (iv.start <= p0 && iv.end >= p1) profs.add(iv.id);
      if (profs.size === 0) continue;
      vaos.push({
        weekday,
        inicio: hhmm(p0),
        fim: hhmm(p1),
        profs_livres: profs.size,
        salas_livres: salasCount, // recorrente: toda sala compatível conta livre no expediente
      });
    }
  }

  const janela = wkMin !== Infinity
    ? { weekday_min: wkMin, weekday_max: wkMax, hora_min: hhmm(horaMin), hora_max: hhmm(horaMax) }
    : emptyJanela;

  return { vaos, janela };
}

module.exports = { computeVaos, mergeIntervals, intersectLists, toMin, hhmm };
