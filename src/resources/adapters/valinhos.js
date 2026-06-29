'use strict';

// valinhos.js — ADAPTER `SCRAPE_EXTRANET` de Valinhos (ADR-026 §2.1/§2.6, Apêndice A).
//
// ÚNICO lugar do sistema que conhece a Extranet: endpoints, de-para 33→22, mapa de
// status Ativo/Inativo, forma do HTML. NADA disso vaza para o core (sync.js) — o
// adapter só DEVOLVE um ResourceSnapshot genérico (snapshot.js).
//
// Expõe DUAS funções separadas (ADR-026 §2.1):
//   - fetch(...)  → bate na fonte (Extranet). NÃO usado na Parte 1 (stub que recusa).
//   - parse(dirs) → HTML já salvo → ResourceSnapshot genérico. É o que roda aqui.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// DE-PARA FECHADO: 33 disciplinas da Extranet → 22 capabilities canônicas.
// Formato (dupla/grupo/individual/turma) COLAPSA na base e vira atributo do vínculo
// (fora de escopo até haver consumidor — ADR-026 §3). id 16 (Piano e Teclado) → DOIS.
// ---------------------------------------------------------------------------
const DEPARA = {
  12: [['Guitarra']],            40: [['Guitarra', 'dupla']],
  13: [['Baixo']],
  14: [['Violão']],              28: [['Violão', 'dupla']],   36: [['Violão', 'grupo']],
  15: [['Canto']],               32: [['Canto', 'dupla']],
  16: [['Piano'], ['Teclado']],
  34: [['Piano']],
  35: [['Teclado']],             38: [['Teclado', 'dupla']],
  17: [['Bateria']],             39: [['Bateria', 'dupla']],
  20: [['Prática em Conjunto']],
  21: [['Harmônica']],           41: [['Harmônica', 'dupla']],
  33: [['Ukulele']],
  24: [['Musicalização', 'grupo']], 27: [['Musicalização', 'individual']],
  44: [['Musicoterapia']],
  50: [['Violino']],             51: [['Saxofone']],          45: [['Violoncelo']],
  18: [['Teoria Musical']],      23: [['Improvisação']],      22: [['Gravação']],
  19: [['Home Studio']],         46: [['Inicialização Musical']],
  47: [['Produção', 'individual']], 48: [['Produção', 'turma']],
  42: [['JAM']],                 43: [['JAM']],
};

// Mapa de status do cadastro (Apêndice A): Ativo→true, Inativo→false.
const STATUS_ATIVO = 'Ativo';

// Catálogo das 22 capabilities (ordem estável), derivado do DE-PARA.
const CAPABILITIES = (() => {
  const seen = new Set();
  const out = [];
  for (const arr of Object.values(DEPARA)) {
    for (const [cap] of arr) {
      if (!seen.has(cap)) { seen.add(cap); out.push(cap); }
    }
  }
  return out.sort((a, b) => a.localeCompare(b, 'pt'));
})();

const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const capRef = (name) => `cap:${slug(name)}`;

const dec = (s) => (s || '')
  .replace(/&ccedil;/g, 'ç').replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é')
  .replace(/&iacute;/g, 'í').replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú')
  .replace(/&atilde;/g, 'ã').replace(/&otilde;/g, 'õ').replace(/&acirc;/g, 'â')
  .replace(/&ecirc;/g, 'ê').replace(/&ocirc;/g, 'ô').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const norm = (s) => dec(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// ---- parse de uma SALA (disponibilidade_salas_lista) → nome + vocação ----
function parseSala(html, idSala) {
  const m = html.match(/<tr[^>]*>\s*<td>\s*<strong>([\s\S]*?)<\/strong>/i);
  const nomeFull = m ? dec(m[1]) : `Sala ${idSala}`;
  const par = nomeFull.match(/\(([^)]*)\)/);
  let apelido = null, vocacao = null;
  if (par) {
    const inner = par[1].trim();
    if (inner.includes(' - ')) [apelido, vocacao] = inner.split(' - ').map((x) => x.trim());
    else { apelido = inner; vocacao = 'Estúdio'; }
  }
  return { ref: String(idSala), type: 'ROOM', name: nomeFull, attributes: { apelido, vocacao } };
}

// ---------------------------------------------------------------------------
// SUGESTÃO de capabilities por VOCAÇÃO da sala (de-para ESPECÍFICO de Valinhos —
// fica SÓ aqui, anti-vazamento ADR-026 §2.1). Pura, sem rede. A tela usa isso para
// pré-marcar chips quando a sala ainda não tem vínculo confirmado (estado SUGERIDA).
// Devolve REFS de capability (cap:*) — a rota resolve p/ as caps reais do tenant e
// ignora ref que não exista. Vocação sem mapa (inclui 'Estúdio') → [] (sem sugestão).
const ROOM_CAP_SUGGESTIONS = {
  'canto e teclas': ['cap:canto', 'cap:teclado', 'cap:piano'],
  'cordas': ['cap:violao', 'cap:guitarra', 'cap:baixo', 'cap:ukulele'],
  'musicalizacao infantil': ['cap:musicalizacao', 'cap:inicializacao-musical'],
};
function suggestRoomCaps(vocacao) {
  if (!vocacao || typeof vocacao !== 'string') return []; // null/undefined/não-string → sem sugestão
  const key = norm(vocacao); // case-insensitive + trim + sem acento (robusto)
  const refs = ROOM_CAP_SUGGESTIONS[key];
  return refs ? [...refs] : [];
}

// ---- parse de um CADASTRO de professor (update.php) → id, nome, status, disciplinas ----
function parseCadastro(html, idCad) {
  const nome = dec((html.match(/<input[^>]*name=["']?nome["']?[^>]*value=["']([^"']*)["']/i) || [])[1] || '');
  const selStatus = html.match(/<select[^>]*name=["']?status["']?[^>]*>([\s\S]*?)<\/select>/i);
  let status = '?';
  if (selStatus) {
    const sel = selStatus[1].match(/<option[^>]*value=["']?([^"'>]*)["']?[^>]*selected/i);
    status = sel ? sel[1] : (selStatus[1].match(/<option[^>]*value=["']?([^"'>]*)/i) || [])[1];
  }
  const disc = [];
  for (const tag of html.match(/<input[^>]*type=["']?checkbox["']?[^>]*>/gi) || []) {
    if (!/curso|disciplina/i.test(tag) || !/checked/i.test(tag)) continue;
    const id = (tag.match(/value=["']?(\d+)/) || [])[1];
    if (id) disc.push(Number(id));
  }
  return { ref: String(idCad), nome, status, disciplinas: disc };
}

// ---- parse da GRADE (buscar_lista) → disponibilidade por professor (intervalos) ----
function mergeHoras(horas) {
  const hs = [...new Set(horas)].sort((a, b) => a - b);
  const out = [];
  let s = null, p = null;
  for (const h of hs) {
    if (s == null) { s = h; p = h; }
    else if (h === p + 1) { p = h; }
    else { out.push([s, p + 1]); s = h; p = h; }
  }
  if (s != null) out.push([s, p + 1]);
  const hh = (n) => `${String(n).padStart(2, '0')}:00`;
  return out.map(([a, b]) => ({ start: hh(a), end: hh(b) }));
}
function parseGradeInto(html, byProf) {
  const body = html.replace(/<thead[\s\S]*?<\/thead>/i, '');
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]).filter((r) => /<strong>/i.test(r));
  for (const r of rows) {
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    const nome = dec(cells[0]);
    if (!nome) continue;
    const k = norm(nome);
    if (!byProf.has(k)) byProf.set(k, {});
    const disp = byProf.get(k);
    for (let wd = 1; wd <= 6; wd++) {
      const horas = [...(cells[wd] || '').matchAll(/<p[^>]*>\s*(\d{1,2}):\d{2}/gi)].map((m) => Number(m[1]));
      if (horas.length) disp[wd] = mergeHoras(horas);
    }
  }
}

// ---------------------------------------------------------------------------
// parse(dirs) → ResourceSnapshot genérico.
//   dirs = { salasDir, cursosDir, cadastroDirs: [..] }
// ---------------------------------------------------------------------------
function parse(dirs) {
  const { salasDir, cursosDir, cadastroDirs } = dirs;

  // capabilities (catálogo de 22)
  const capabilities = CAPABILITIES.map((name) => ({ ref: capRef(name), name }));

  const resources = [];

  // SALAS (sem vínculo de disciplina — a Extranet não cadastra isso)
  for (const f of fs.readdirSync(salasDir)) {
    const m = f.match(/^sala-(\d+)\.html$/);
    if (!m) continue;
    resources.push(parseSala(fs.readFileSync(path.join(salasDir, f), 'utf8'), Number(m[1])));
  }

  // GRADE → disponibilidade por professor (chave = nome normalizado)
  const gradeByProf = new Map();
  for (const f of fs.readdirSync(cursosDir)) {
    if (!/^curso-\d+\.html$/.test(f)) continue;
    parseGradeInto(fs.readFileSync(path.join(cursosDir, f), 'utf8'), gradeByProf);
  }

  // PROFESSORES: competência + status do CADASTRO (autoritativo); filtra ATIVOS.
  for (const dir of cadastroDirs) {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^cad-(\d+)\.html$/);
      if (!m) continue;
      const cad = parseCadastro(fs.readFileSync(path.join(dir, f), 'utf8'), Number(m[1]));
      if (cad.status !== STATUS_ATIVO) continue; // Inativo → fora do roster ativo (§2.3)

      // disciplinas → capabilities (dedup), via de-para
      const caps = new Set();
      for (const did of cad.disciplinas) {
        for (const [cap] of (DEPARA[did] || [])) caps.add(capRef(cap));
      }
      // disponibilidade do professor (join por nome normalizado com a grade)
      const disp = gradeByProf.get(norm(cad.nome)) || {};
      const availability = [];
      for (let wd = 1; wd <= 6; wd++) {
        for (const iv of disp[wd] || []) availability.push({ weekday: wd, start: iv.start, end: iv.end });
      }

      resources.push({
        ref: cad.ref,
        type: 'TEACHER',
        name: cad.nome,
        attributes: {},
        capabilityRefs: [...caps],
        availability,
      });
    }
  }

  return { capabilities, resources };
}

// Cursos pesquisáveis na busca de grade (buscar_lista) — subconjunto das 33
// disciplinas que a tela de busca por curso expõe (Apêndice A do ADR-026).
const CURSOS_BUSCA = [13, 17, 15, 12, 40, 21, 24, 27, 44, 34, 16, 20, 35, 33, 14];

const EP = {
  sala: (id) => `/rel_cont_mat/disponibilidade_salas_lista.php?id_sala=${id}`,
  grade: (curso) => `/mod_professores/buscar_lista.php?curso=${curso}&professor=&dias=&horario=`,
  listaProf: () => `/mod_professores/monta_lista.php?pg=1&num_por_pagina=500&condicao=&status=`,
  cadastro: (id) => `/mod_professores/update.php?id=${id}`,
};

// fetch(transport, { destDir, onProgress }) — orquestra os GETs na fonte e grava o
// HTML bruto em destDir (raw/ e raw-cad/), de onde parse() consome.
//
// O `transport(path) → Promise<html>` é INJETADO: faz o GET autenticado SOB THROTTLE
// e PARA no 1º bloqueio (responsabilidade do transporte). Assim o adapter conhece só
// endpoints/parse; auth+throttle ficam fora (nesta rodada inaugural, transporte =
// sessão do disco; nos runs diários da Parte 3, transporte = login pelas creds do
// binding). Se o transporte lançar (bloqueio), a varredura para e propaga.
async function fetch(transport, { destDir, onProgress = () => {} } = {}) {
  const rawDir = path.join(destDir, 'raw');
  const cadDir = path.join(destDir, 'raw-cad');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(cadDir, { recursive: true });
  const save = (dir, name, html) => fs.writeFileSync(path.join(dir, name), html);

  // 1) salas (9)
  for (let id = 1; id <= 9; id++) {
    save(rawDir, `sala-${id}.html`, await transport(EP.sala(id)));
    onProgress({ step: 'sala', id });
  }
  // 2) grade por curso (15) — disponibilidade recorrente + nomes dos professores ativos
  const nomesGrade = new Set();
  for (const curso of CURSOS_BUSCA) {
    const html = await transport(EP.grade(curso));
    save(rawDir, `curso-${curso}.html`, html);
    for (const m of html.matchAll(/<strong>([\s\S]*?)<\/strong>/gi)) nomesGrade.add(norm(m[1]));
    onProgress({ step: 'grade', curso });
  }
  // 3) lista de professores → mapa nome→id de cadastro
  const lista = await transport(EP.listaProf());
  const nomeToId = new Map();
  for (const tr of (lista.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [])) {
    const nome = dec((tr.match(/<td[^>]*>([\s\S]*?)<\/td>/i) || [])[1] || '');
    const id = (tr.match(/update\.php\?id=(\d+)/) || [])[1];
    if (nome && id) nomeToId.set(norm(nome), Number(id));
  }
  // 4) cadastro (competência + status autoritativos) só dos professores que aparecem
  //    na grade — o roster ativo. Inativos não aparecem na grade (logo, fora).
  const ids = [...nomesGrade].map((n) => nomeToId.get(n)).filter((x) => x != null);
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    save(cadDir, `cad-${id}.html`, await transport(EP.cadastro(id)));
    onProgress({ step: 'cadastro', id });
  }

  return { salasDir: rawDir, cursosDir: rawDir, cadastroDirs: [cadDir] };
}

// ---------------------------------------------------------------------------
// OCUPAÇÃO DATADA (ADR-025 emenda / fatia 048) — leitura AO VIVO, NÃO cacheada.
// Tudo aqui é do adapter (conhece a Extranet); o core não importa nada disto.
// ---------------------------------------------------------------------------

// parseGradeOcupacao(html) — HTML de api-salas-grade.php?hoje=DATA → slots OCUPADOS do dia.
// Ocupação = PRESENÇA da âncora (aula_edit). Sem âncora = livre. Cancelado some da grade.
// Status é textual (Prevista/Confirmada/Realizada/Falta/experimental); o sufixo "- " (vazio,
// visto em "Prevista - "/"Realizada - ") é decoração → normalizado fora. NÃO devolve aluno (PII):
// p/ ocupação só importa sala×horário×status.
function parseGradeOcupacao(html) {
  const out = [];
  // captura também o conteúdo VISÍVEL da âncora (m[3]) — é de lá que sai "Prof. <nome>"
  // (o title NÃO traz o professor nesta tela).
  const re = /<a\b[^>]*aula_edit\(\s*['"]?(\d+)['"]?\s*\)[^>]*\btitle\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const aulaId = m[1];
    const lines = m[2].replace(/&#10;|&#xA;/gi, '\n').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    let hora_inicio = null, hora_fim = null, sala = null, curso = null;
    for (const line of lines) {
      let mt;
      if ((mt = line.match(/^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/))) { hora_inicio = mt[1]; hora_fim = mt[2]; continue; }
      if (/^Sala\b/i.test(line)) { sala = dec(line); continue; }
      if (/^Curso\b/i.test(line) || /^Aula experimental/i.test(line)) { curso = dec(line); continue; }
    }
    // status = última linha; normaliza o sufixo "- " vazio ("Prevista - " → "Prevista").
    const status = dec(lines[lines.length - 1] || '').replace(/\s*-\s*$/, '').trim();
    // prof: do texto visível, após a ÚLTIMA "Prof." (até 3 tokens de nome).
    let prof = null;
    const vis = dec(m[3] || '');
    const pidx = vis.toLowerCase().lastIndexOf('prof.');
    if (pidx >= 0) {
      const after = vis.slice(pidx + 5).trim();
      const w = after.match(/^([\p{L}][\p{L}-]*(?:\s+[\p{L}][\p{L}-]*){0,3})/u);
      if (w) prof = w[1].trim();
    }
    out.push({ aula_id: aulaId, hora_inicio, hora_fim, sala, curso, status, prof, ocupado: true });
  }
  return out;
}

// matchTeacher — casa o "Prof." (nome CURTO da grade) ↔ professor do catálogo por PREFIXO
// ANCORADO: o nome da grade tem que ser prefixo do nome completo, token a token do 1º em
// diante. Resolve a colisão de nome-do-meio: "César" é nome do meio de "Augusto César ..."
// E de "Ricardo ... César ..." → não casa por prefixo com NENHUM (1º token é Augusto/Ricardo)
// → fica NÃO-RESOLVIDO (melhor faltar que atribuir errado). "Augusto"→Augusto César,
// "Ricardo"→Ricardo, ambos ÚNICOS.
// APROXIMAÇÃO p/ métrica de TENDÊNCIA (gestão), NÃO exatidão — o nome da grade é curto/"de
// guerra"; a via exata (api-salas-grade?professor=<id> por professor, ~138 fetches/dia)
// estoura o throttle. Retorna { resource_id } se ÚNICO; senão { ambiguous:true, n } (0 ou >1).
function matchTeacher(prof, teachers) {
  const pt = norm(prof).split(/\s+/).filter(Boolean);
  if (!pt.length) return { ambiguous: true, n: 0 };
  const cand = teachers.filter((t) => {
    const tt = norm(t.name).split(/\s+/).filter(Boolean);
    return pt.every((p, i) => tt[i] && (tt[i] === p || tt[i].startsWith(p)));
  });
  return cand.length === 1 ? { resource_id: cand[0].resource_id } : { ambiguous: true, n: cand.length };
}

// ---------------------------------------------------------------------------
// DP-C (ADR-025) — MAPA status→ocupa? do slot, ESPECÍFICO DA FONTE (fica SÓ no adapter,
// fronteira anti-vazamento). A grade datada (api-salas-grade) lista aulas com status textual;
// nem todo status consome o slot: CANCELAMENTO libera o horário (a aula aparece na grade
// futura, mas não é aula firme). Decisão CONSERVADORA: status desconhecido conta como OCUPADO
// (não oferecer um slot que pode estar tomado) — e o chamador loga os desconhecidos p/ revisão.
const STATUS_OCUPA = new Set(
  ['Prevista', 'Confirmada pelo aluno', 'Confirmada', 'Realizada', 'Falta do aluno', 'Falta'].map((s) => norm(s)));

// statusOcupa(status) → boolean. true = a aula OCUPA o slot; false = slot livre (cancelada).
// PURA. Normaliza (trim/case/acento). Qualquer 'Cancelada*' → livre; conhecido-ocupa → true;
// desconhecido/vazio → true (conservador).
function statusOcupa(status) {
  const s = norm(status);
  if (s.startsWith('cancelada')) return false; // 'Cancelada pelo aluno/professor/período de ausência' …
  if (STATUS_OCUPA.has(s)) return true;
  return true;                                  // desconhecido/vazio → conservador (ocupado)
}
// O status é reconhecido pelo mapa DP-C? (p/ o chamador logar os desconhecidos e revisarmos o mapa.)
function statusConhecido(status) {
  const s = norm(status);
  return s.startsWith('cancelada') || STATUS_OCUPA.has(s);
}

// DE-PARA SIGLA do curso da grade (api-salas-grade: "Curso DRUM") → ref de capability.
// USO: SÓ VALIDAÇÃO INFORMATIVA (conferir se o instrumento da aula bate com a vocação da
// sala). A linha de ocupação da SALA usa a VOCAÇÃO real (resource_capability), NÃO isto.
// Específico da fonte (siglas observadas no recon ao vivo). Pura; null se a sigla não mapear.
const CURSO_SIGLA_CAP = {
  DRUM: 'cap:bateria', VOCAL: 'cap:canto', GUIT: 'cap:guitarra', BASS: 'cap:baixo', PIA: 'cap:piano',
};
function cursoCapRef(curso) {
  const toks = String(curso || '').toUpperCase().match(/[A-Z]+/g) || [];
  for (const t of toks) if (CURSO_SIGLA_CAP[t]) return CURSO_SIGLA_CAP[t];
  return null;
}

// Próxima data (>= fromYmd, inclui hoje) cujo weekday ISO bate. Usado p/ a janela do
// snapshot diário: a próxima ocorrência de cada weekday de trabalho.
function nextOccurrenceDate(fromYmd, weekdayIso) {
  for (let i = 0; i < 7; i++) { const d = _ymdAddDays(fromYmd, i); if (_weekdayIso(d) === weekdayIso) return d; }
  return fromYmd;
}

const _salaMatch = (a, b) => String(a || '').toLowerCase().replace(/\s+/g, '') === String(b || '').toLowerCase().replace(/\s+/g, '');
function _ymdAddDays(ymd, n) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}
function _weekdayIso(ymd) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0=Dom..6=Sáb
  return wd === 0 ? 7 : wd;                                // ISO 1=Seg..7=Dom
}

// readSlot3Weeks — REGRA DAS 3 SEMANAS (ADR-025 emenda decisão 4). Lê AO VIVO o mesmo
// weekday+horário em 3 datas consecutivas (a clicada + 2 seguintes). IO é INJETADO
// (mantém este módulo puro / sem db/lock/transport):
//   getGradeHtml(dateYmd) -> Promise<html>   // o chamador embrulha com lock SÓ no GET
//   isException(dateYmd)  -> Promise<bool>    // o chamador consulta resource_exception
//   throttle?()          -> Promise<void>    // espera o gap ENTRE datas, FORA do lock
//   onOccurrence?(occ)   -> Promise<void>    // STREAMING: chamado quando CADA data resolve
// O gap fica FORA do lock (chamado aqui, entre as datas) → o lock é retido só durante o
// GET (~0,5s), não monopoliza a Extranet durante a espera do throttle.
// Estados por ocorrência: livre / ocupada_por_aula / bloqueada_por_excecao / indisponivel.
// Falha numa data (ex.: lock timeout = sistema ocupado) NÃO derruba as outras — vira
// 'indisponivel' só naquela data. NÃO decide "vale ou não" — a tela mostra e a humana decide.
async function readSlot3Weeks({ anchorDate, time, sala = null }, { getGradeHtml, isException, throttle, onOccurrence }) {
  const weekday = _weekdayIso(anchorDate);
  const occurrences = [];
  for (let i = 0; i < 3; i++) {
    const date = _ymdAddDays(anchorDate, i * 7);
    let occ;
    try {
      if (await isException(date)) {
        occ = { occurrence: i + 1, date, weekday, state: 'bloqueada_por_excecao', ocupadas: [] }; // não bate na Extranet
      } else {
        if (i > 0 && typeof throttle === 'function') await throttle();   // gap FORA do lock, antes do GET
        const slots = parseGradeOcupacao(await getGradeHtml(date));
        const ocupadas = slots.filter((s) => s.hora_inicio === time && (!sala || _salaMatch(s.sala, sala)));
        occ = { occurrence: i + 1, date, weekday, state: ocupadas.length ? 'ocupada_por_aula' : 'livre', ocupadas: ocupadas.map((s) => ({ sala: s.sala, curso: s.curso, status: s.status })) };
      }
    } catch (e) {
      const lockBusy = /lock timeout|canceling statement due to lock/i.test(e && e.message || '');
      occ = { occurrence: i + 1, date, weekday, state: 'indisponivel', reason: lockBusy ? 'sistema_ocupado' : 'erro_consulta', ocupadas: [] };
    }
    occurrences.push(occ);
    if (typeof onOccurrence === 'function') { try { await onOccurrence(occ); } catch (_e) { /* stream best-effort */ } }
  }
  return { anchorDate, time, weekday, sala, occurrences };
}

// ---------------------------------------------------------------------------
// MULTI-SLOT (até 3) — evolução da leitura ao vivo. Mesma REGRA DAS 3 SEMANAS, mas
// agrupando slots que colapsam nas MESMAS datas (terça 14h + terça 15h = mesmas 3 datas):
// busca cada DATA distinta UMA vez e distribui os horários pedidos daquele HTML. O throttle
// e o lock continuem invioláveis (teto anti-429) — o agrupamento reduz o nº de requisições,
// não o espaçamento. Reusa parseGradeOcupacao (NÃO reescreve a leitura).
// ---------------------------------------------------------------------------

const _toMinV = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

// matchOcupacao — o intervalo do SLOT [ini,fim) sobrepõe o da AULA [hi,hf)? O front manda
// ini/fim do bloco arrastado (60 ou 90min); a rota NÃO calcula duração de turma. Aula sem
// hora_fim (raro) vira ponto: conta se o início cair dentro do slot.
function matchOcupacao(slotIni, slotFim, aulaIni, aulaFim) {
  if (aulaIni == null) return false;
  const a1 = _toMinV(slotIni), a2 = _toMinV(slotFim);
  const b1 = _toMinV(aulaIni), b2 = aulaFim != null ? _toMinV(aulaFim) : b1 + 1;
  return a1 < b2 && b1 < a2;
}

// parseSlotsInput(query) — normaliza a querystring em { slots:[{key,anchorDate,inicio,fim}], sala }
// ou { error }. Duas formas de entrada MULTI (a forma LEGADA 1-slot sem 'fim'/'slots' é tratada
// fora, direto pelo readSlot3Weeks):
//   ?slots=YYYY-MM-DD@HH:MM[@HH:MM],...   (até 3; @ separa data@inicio@fim; fim default +60)
//   ?anchor=YYYY-MM-DD&time=HH:MM[&fim=HH:MM]   (1 slot com fim explícito → semântica de intervalo)
function parseSlotsInput(query) {
  const reDate = /^\d{4}-\d{2}-\d{2}$/, reTime = /^\d{2}:\d{2}$/;
  const sala = query.sala ? String(query.sala) : null;
  const fimDefault = (ini) => { const t = _toMinV(ini) + 60; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

  if (query.slots !== undefined) {
    const pieces = String(query.slots).split(',').map((s) => s.trim()).filter(Boolean);
    if (!pieces.length) return { error: 'slots vazio' };
    if (pieces.length > 3) return { error: 'máximo de 3 slots por consulta' };
    const slots = [];
    for (const p of pieces) {
      const [anchor, ini, fim] = p.split('@').map((x) => (x == null ? x : x.trim()));
      if (!reDate.test(anchor || '')) return { error: `slot inválido (data): ${p}` };
      if (!reTime.test(ini || '')) return { error: `slot inválido (hora): ${p}` };
      if (fim !== undefined && !reTime.test(fim)) return { error: `slot inválido (fim): ${p}` };
      slots.push({ key: `${anchor}T${ini}`, anchorDate: anchor, inicio: ini, fim: fim || fimDefault(ini) });
    }
    return { slots, sala };
  }

  const anchor = String(query.anchor || ''), time = String(query.time || '');
  if (!reDate.test(anchor)) return { error: 'anchor inválido (YYYY-MM-DD)' };
  if (!reTime.test(time)) return { error: 'time inválido (HH:MM)' };
  const fim = query.fim !== undefined ? String(query.fim) : undefined;
  if (fim !== undefined && !reTime.test(fim)) return { error: 'fim inválido (HH:MM)' };
  return { slots: [{ key: `${anchor}T${time}`, anchorDate: anchor, inicio: time, fim: fim || fimDefault(time) }], sala };
}

// Datas DISTINTAS (a regra das 3 semanas aplicada a cada slot, DEDUPLICADAS). Ordenadas.
function distinctSlotDates(slots) {
  const set = new Set();
  for (const s of slots) for (let i = 0; i < 3; i++) set.add(_ymdAddDays(s.anchorDate, i * 7));
  return [...set].sort();
}

// readSlotsMulti — busca cada DATA distinta UMA vez (throttle só ENTRE fetches reais) e emite
// uma ocorrência por (slot × semana), STREAMING agrupado por data conforme cada data resolve.
// Shape dos eventos = igual ao readSlot3Weeks + campo NOVO 'slotKey' (identifica o slot).
async function readSlotsMulti({ slots, sala = null }, { getGradeHtml, isException, throttle, onOccurrence }) {
  const slotDates = slots.map((s) => ({
    slot: s,
    dates: [0, 1, 2].map((i) => _ymdAddDays(s.anchorDate, i * 7)),
    weekday: _weekdayIso(s.anchorDate),
  }));
  const occurrences = [];
  let fetchCount = 0;

  for (const date of distinctSlotDates(slots)) {
    let parsed;
    try {
      if (await isException(date)) {
        parsed = { exception: true }; // não bate na Extranet
      } else {
        if (fetchCount > 0 && typeof throttle === 'function') await throttle(); // gap só entre GETs reais
        fetchCount++;
        parsed = { slots: parseGradeOcupacao(await getGradeHtml(date)) };
      }
    } catch (e) {
      const lockBusy = /lock timeout|canceling statement due to lock/i.test(e && e.message || '');
      parsed = { error: lockBusy ? 'sistema_ocupado' : 'erro_consulta' };
    }

    for (const sd of slotDates) {
      const i = sd.dates.indexOf(date);
      if (i === -1) continue; // esta data não pertence a este slot
      const base = { slotKey: sd.slot.key, occurrence: i + 1, date, weekday: sd.weekday };
      let occ;
      if (parsed.exception) {
        occ = { ...base, state: 'bloqueada_por_excecao', ocupadas: [] };
      } else if (parsed.error) {
        occ = { ...base, state: 'indisponivel', reason: parsed.error, ocupadas: [] };
      } else {
        const ocupadas = parsed.slots.filter((s) =>
          matchOcupacao(sd.slot.inicio, sd.slot.fim, s.hora_inicio, s.hora_fim) && (!sala || _salaMatch(s.sala, sala)));
        occ = { ...base, state: ocupadas.length ? 'ocupada_por_aula' : 'livre', ocupadas: ocupadas.map((s) => ({ sala: s.sala, curso: s.curso, status: s.status })) };
      }
      occurrences.push(occ);
      if (typeof onOccurrence === 'function') { try { await onOccurrence(occ); } catch (_e) { /* stream best-effort */ } }
    }
  }

  return {
    slots: slotDates.map((sd) => ({ slotKey: sd.slot.key, anchorDate: sd.slot.anchorDate, inicio: sd.slot.inicio, fim: sd.slot.fim, weekday: sd.weekday })),
    occurrences,
  };
}

module.exports = { parse, fetch, CAPABILITIES, CURSOS_BUSCA, DEPARA, capRef, parseGradeOcupacao, readSlot3Weeks, matchTeacher, nextOccurrenceDate, suggestRoomCaps, parseSlotsInput, distinctSlotDates, matchOcupacao, readSlotsMulti, statusOcupa, statusConhecido, cursoCapRef };
