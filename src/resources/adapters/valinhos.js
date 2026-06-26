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

module.exports = { parse, fetch, CAPABILITIES, CURSOS_BUSCA, DEPARA, capRef };
