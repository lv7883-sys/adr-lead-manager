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
 *     expediente MENOS onde sua ocup a cobre. < 1 sala → sem lugar físico → só buracos.
 * @param {Map<number, Array<{start:number,end:number}>>} expediente
 *   - por weekday (ISO 1=seg..7=dom), faixas do horário de atendimento em MINUTOS.
 * @returns {{ vaos: Array<{weekday:number,inicio:string,fim:string,profs_livres:number,salas_livres:number,
 *                          profs_livres_ids:string[],salas_livres_ids:string[]}>,
 *             buracos: Array<{weekday:number,inicio:string,fim:string,motivo:'sem_professor'|'sem_sala'|'sem_ambos'}>,
 *             janela: {weekday_min:number|null, weekday_max:number|null, hora_min:string|null, hora_max:string|null} }}
 *
 * FOLGA = CONCORRÊNCIA REAL dos dois lados. Sweep line por weekday nos pontos onde QUALQUER
 * contagem muda: start/end de disponibilidade de prof, de ocupação de prof, de ocupação de sala,
 * e abre/fecha do expediente. Cada SUBVÃO entre dois pontos tem profs_livres / salas_livres
 * CONSTANTES. profs_livres = profs DISPONÍVEIS e NÃO-ocupados ali; salas_livres = salas
 * compatíveis NÃO-ocupadas ali (ids materializados p/ o hover da tela).
 *
 * COBERTURA TOTAL do expediente: cada subvão DENTRO do expediente é OU um vão (ambos >= 1) OU um
 * BURACO classificado por motivo. A varredura percorre TODOS os weekdays abertos do expediente
 * (não só onde há professor) — um dia inteiro sem professor vira buraco 'sem_professor'/'sem_ambos'.
 * vãos ∪ buracos = 100% do expediente, sem sobreposição. Buracos adjacentes de MESMO motivo são
 * fundidos; vãos adjacentes com CONTINUIDADE DE RECURSO (interseção de profs E de salas livres ≥1
 * no bloco inteiro) também são fundidos — os nomes/contagem do bloco = a interseção (só quem cobre
 * o bloco todo). Sem continuidade real, os vãos ficam separados (folga genuinamente distinta).
 */
function computeVaos(professores, salas = [], expediente = new Map()) {
  if (!(expediente instanceof Map)) expediente = new Map();
  const emptyJanela = { weekday_min: null, weekday_max: null, hora_min: null, hora_max: null };
  const salaIds = salas.map((s) => s.id);

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
  const buracosRaw = []; // {weekday,start,end,motivo} em minutos, pré-fusão
  // Varre TODOS os dias abertos do EXPEDIENTE (não só onde há professor) — assim o branco de um dia
  // sem professor nenhum também é classificado. Cada subvão dentro do expediente é vão OU buraco.
  for (const weekday of [...expediente.keys()].sort((a, b) => a - b)) {
    const exp = expediente.get(weekday) || [];
    if (!exp.length) continue; // dia fechado → fora do frame
    const avail = profAvailByDay.get(weekday) || [];
    const profOcup = profOcupByDay.get(weekday) || [];
    const salaOcup = salaOcupByDay.get(weekday) || [];

    // Sweep line: fronteiras = todos os start/end (avail ∪ ocup-prof ∪ ocup-sala ∪ expediente).
    // Entre duas fronteiras a cobertura é constante: cada intervalo cobre o subvão inteiro
    // (start <= p0 && end >= p1) ou não o toca. O expediente está nas fronteiras → todo instante
    // dentro do expediente cai em algum subvão (cobertura sem furo).
    const bounds = [...new Set(
      [...avail, ...profOcup, ...salaOcup, ...exp].flatMap((iv) => [iv.start, iv.end]))].sort((a, b) => a - b);
    for (let k = 0; k + 1 < bounds.length; k++) {
      const p0 = bounds[k], p1 = bounds[k + 1];
      if (!exp.some((f) => f.start <= p0 && f.end >= p1)) continue; // fora do expediente → nem vão nem buraco

      // professores LIVRES = disponíveis aqui E não-ocupados aqui (ids materializados).
      const profsLivres = new Set();
      for (const iv of avail) if (iv.start <= p0 && iv.end >= p1) profsLivres.add(iv.id);
      for (const iv of profOcup) if (iv.start <= p0 && iv.end >= p1) profsLivres.delete(iv.id);

      // salas LIVRES = selecionadas − ocupadas aqui (ids materializados).
      const salasOcupadas = new Set();
      for (const iv of salaOcup) if (iv.start <= p0 && iv.end >= p1) salasOcupadas.add(iv.id);
      const salasLivresIds = salaIds.filter((id) => !salasOcupadas.has(id));

      // Classifica os DOIS lados ANTES de decidir (sem sair cedo) — assim o motivo do branco é exato.
      if (profsLivres.size >= 1 && salasLivresIds.length >= 1) {
        // Cru em MINUTOS (_ini/_fim) — a fusão de vãos adjacentes roda depois, em minutos; hhmm no fim.
        vaos.push({
          weekday,
          _ini: p0,
          _fim: p1,
          profs_livres_ids: [...profsLivres],
          salas_livres_ids: salasLivresIds,
        });
      } else {
        const motivo = profsLivres.size === 0 && salasLivresIds.length === 0 ? 'sem_ambos'
          : (profsLivres.size === 0 ? 'sem_professor' : 'sem_sala');
        buracosRaw.push({ weekday, start: p0, end: p1, motivo });
      }
    }
  }

  // Funde VÃOS adjacentes com CONTINUIDADE DE RECURSO (espelha a fusão de buracos logo abaixo).
  // A sweep-line fatia um vão contínuo sempre que a COMPOSIÇÃO de quem está livre muda no meio,
  // mesmo continuando a haver vaga. Dois vãos adjacentes (mesmo weekday, fim==início) fundem SE a
  // INTERSEÇÃO de profs livres E a INTERSEÇÃO de salas livres do bloco ACUMULADO forem ambas ≥1 —
  // i.e. existe ≥1 professor E ≥1 sala livres no bloco INTEIRO. TRANSITIVA com interseção acumulada
  // (o recurso tem que cobrir TODOS os pedaços): se ao estender a cadeia a interseção zera de um
  // lado, para ali — fecha o bloco no ponto anterior e recomeça em v. Sem continuidade real (ex.:
  // sala A só na 1ª metade, sala B só na 2ª → interseção vazia) NÃO funde: são vãos distintos.
  // Não depende de duração de aula (multi-tenant / 45min): junta por continuidade de recurso, e o
  // bloco contínuo serve pra qualquer duração — quem fatia é o arrasto/digitação da tela.
  const vaosFundidos = [];
  for (const v of vaos) {
    const last = vaosFundidos[vaosFundidos.length - 1];
    if (last && last.weekday === v.weekday && last._fim === v._ini) {
      const vProfSet = new Set(v.profs_livres_ids);
      const vSalaSet = new Set(v.salas_livres_ids);
      const profInter = last.profs_livres_ids.filter((id) => vProfSet.has(id));
      const salaInter = last.salas_livres_ids.filter((id) => vSalaSet.has(id));
      if (profInter.length >= 1 && salaInter.length >= 1) {
        last._fim = v._fim;
        last.profs_livres_ids = profInter; // interseção acumulada = livres o bloco INTEIRO
        last.salas_livres_ids = salaInter;
        continue;
      }
    }
    vaosFundidos.push({
      weekday: v.weekday, _ini: v._ini, _fim: v._fim,
      profs_livres_ids: [...v.profs_livres_ids], salas_livres_ids: [...v.salas_livres_ids],
    });
  }
  // Materializa a saída dos vãos: hhmm + contagem (retrocompat) derivada da interseção final.
  const vaosOut = vaosFundidos.map((v) => ({
    weekday: v.weekday,
    inicio: hhmm(v._ini),
    fim: hhmm(v._fim),
    profs_livres: v.profs_livres_ids.length,
    salas_livres: v.salas_livres_ids.length,
    profs_livres_ids: v.profs_livres_ids,
    salas_livres_ids: v.salas_livres_ids,
  }));

  // Funde buracos adjacentes (mesmo weekday + motivo + contíguos) → menos fragmentos pro front.
  buracosRaw.sort((a, b) => a.weekday - b.weekday || a.start - b.start);
  const buracos = [];
  for (const b of buracosRaw) {
    const last = buracos[buracos.length - 1];
    if (last && last._wd === b.weekday && last.motivo === b.motivo && last._end === b.start) {
      last._end = b.end;
    } else {
      buracos.push({ _wd: b.weekday, _end: b.end, weekday: b.weekday, inicio: b.start, motivo: b.motivo });
    }
  }
  const buracosOut = buracos.map((b) => ({ weekday: b.weekday, inicio: hhmm(b.inicio), fim: hhmm(b._end), motivo: b.motivo }));

  const janela = wkMin !== Infinity
    ? { weekday_min: wkMin, weekday_max: wkMax, hora_min: hhmm(horaMin), hora_max: hhmm(horaMax) }
    : emptyJanela;

  return { vaos: vaosOut, buracos: buracosOut, janela };
}

module.exports = { computeVaos, mergeIntervals, intersectLists, toMin, hhmm };
