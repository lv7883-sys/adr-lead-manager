'use strict';
//
// valinhos-contratos.js — ADAPTER de contratos/alunos da fonte SCRAPE_EXTRANET (Valinhos).
// TODO o conhecimento da Extranet vive AQUI (regexes, telas). O runner/sync são agnósticos.
// Reusa o extranet-client do LM (sessão/re-login/throttle) + o advisory lock 'extranet-access'.
//
// LOCK POR-FETCH (não o run inteiro): cada requisição roda sob withExtranetLock com o GAP FORA
// do lock — libera o lock entre requests (clique humano tem prioridade na fila). Molde do
// captureHistory do sincronizador de recursos. Throttle ≥25s embutido no client (throttleGap).
//
// PRODUCE → { contratos: [{ idC, idA, curso, status, ini, fim, planoLabel, periodicidade,
//   aluno: { idExterno, nome, dataNascimento?, payerRelation? }, responsavel: { idExterno }|null }] }
//
const { withTenant } = require('../../db');
const { withExtranetLock } = require('../../resources/extranet-lock');
const client = require('../../resources/adapters/extranet-client');

const kind = 'SCRAPE_EXTRANET';

// ---- parse helpers (idênticos ao ctr_runner provado na ingestão 1x) ----
const toISO = (br) => { const m = String(br || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const dec = (s) => String(s || '')
  .replace(/&ccedil;/g, 'ç').replace(/&atilde;/g, 'ã').replace(/&otilde;/g, 'õ').replace(/&aacute;/g, 'á')
  .replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í').replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú')
  .replace(/&acirc;/g, 'â').replace(/&ecirc;/g, 'ê').replace(/&ocirc;/g, 'ô').replace(/&agrave;/g, 'à')
  .replace(/&ordm;/g, 'º').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const strip = (s) => dec(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const field = (h, n) => (h.match(new RegExp(`name=["']${n}["'][^>]*value=["']([^"']*)["']`, 'i')) || [])[1] || '';
const tpsel = (h) => { const s = (h.match(/<select[^>]*name=["']tpresp["'][\s\S]*?<\/select>/i) || [''])[0];
  const m = s.match(/<option[^>]*value=["']([^"']*)["'][^>]*selected/i); return m ? m[1] : ''; };

function pisoPer(ini, fim) { if (!ini || !fim) return null;
  const meses = Math.round((new Date(fim) - new Date(ini)) / (864e5 * 30.44));
  if (meses >= 12) return 'anual'; if (meses >= 6) return 'semestral'; if (meses >= 3) return 'trimestral'; return 'mensal'; }
function descPer(plano) { const t = String(plano || '').toLowerCase();
  if (/mensal/.test(t)) return 'mensal'; if (/trimestr/.test(t)) return 'trimestral';
  if (/semestr/.test(t)) return 'semestral'; if (/anual/.test(t)) return 'anual'; return null; }
// tpresp da Extranet → payer_relation NEUTRO (0=próprio → self_paid; 1/2 → dependente financeiro).
function payerFromTp(tp) { return String(tp) === '0' ? 'self_paid' : (tp ? 'financially_dependent' : null); }

// produce: login + fetch (lista paginada → detalhe → ficha dos dependentes) → snapshot.
// `stats.fetches` conta as requisições. Session resolvida 1x; cada fetch sob lock+gap.
async function produce(binding, { tenantId } = {}) {
  const cfg = binding.config || {};
  const senha = require('../../crypto').decrypt(cfg.credential_enc);
  if (!senha) throw new Error('valinhos-contratos: credencial vazia/indecifrável no binding');
  const creds = { email: cfg.email, senha, perfil: cfg.perfil, unidade: cfg.unidade };

  let session = await client.getSession(creds);
  const stats = { fetches: 0, fichas: 0 };
  // 1 requisição: gap FORA do lock; fetch SOB o lock (noGap: o gap já foi dado); re-login 1x.
  const get = async (path) => {
    await client.throttleGap();
    stats.fetches++;
    try {
      return await withExtranetLock(() => client.fetchAuthed(path, session, { noGap: true }));
    } catch (e) {
      if (/expirad|login|redirect|SESSION_EXPIRED/i.test(e.message)) {
        session = await client.getSession(creds, { force: true });
        return await withExtranetLock(() => client.fetchAuthed(path, session, { noGap: true }));
      }
      throw e;
    }
  };

  // ----- LISTA paginada (300/pág; dedup por idC; para quando não traz idC novo) -----
  let rows = []; const seenC = new Set();
  for (let pg = 1; pg <= 25; pg++) {
    const h = await get(`/mod_contratos/monta_lista.php?pg=${pg}&num_por_pagina=300&nome=&status=&situacao=&plano=&ordemDt=`);
    const pr = (h.match(/<tr[\s\S]*?<\/tr>/gi) || []).filter((r) => /dash-alunos\.php\?id=/i.test(r));
    let novos = 0;
    for (const r of pr) { const idc = (r.match(/(?:Visualizar|Renovar|Imprimir)\(?['"]?(\d+)/i) || [])[1]; if (idc && !seenC.has(idc)) { seenC.add(idc); rows.push(r); novos++; } }
    if (pr.length === 0 || novos === 0) break;
  }
  const parsed = rows.map((r) => {
    const tds = (r.match(/<td[\s\S]*?<\/td>/gi) || []);
    const idA = (r.match(/dash-alunos\.php\?id=(\d+)/i) || [])[1];
    const idC = (r.match(/(?:Visualizar|Renovar|Imprimir)\(?['"]?(\d+)/i) || [])[1];
    const curso = strip(tds[1]);
    const vig = (r.match(/(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/) || []);
    const badge = (r.match(/<span[^>]*badge[^>]*>([^<]+)<\/span>/i) || [])[1];
    return { idA, idC, curso, ini: toISO(vig[1]), fim: toISO(vig[2]), nome: strip(tds[0]), statusCol: strip(tds[4]) || strip(badge) };
  }).filter((x) => x.idA && x.idC && x.ini && x.fim);

  // payer_relation dos alunos (do cadastro já populado) — decide titular + quais fichas buscar
  const payerByAluno = {};
  if (parsed.length) {
    const ids = [...new Set(parsed.map((p) => p.idA))];
    const pr = await withTenant(tenantId, (c) => c.query(
      `SELECT er.external_id, p.payer_relation FROM lead_manager.external_ref er
         JOIN lead_manager.person p ON p.id = er.entity_id
        WHERE er.tenant_id=$1 AND er.entity_kind='person' AND er.external_type='beneficiario' AND er.external_id = ANY($2::text[])`,
      [tenantId, ids]));
    pr.rows.forEach((x) => { payerByAluno[x.external_id] = x.payer_relation; });
  }

  const fichaCache = new Map();
  const contratos = [];
  for (const c of parsed) {
    // DETALHE → plano_label + periodicidade (descritivo → piso)
    const d = await get('/mod_contratos/detalhes.php?id=' + c.idC);
    const pm = d.match(/Plano\s*pagto[\s\S]{0,150}?value=["']([^"']*)["']/i);
    const planoLabel = pm ? dec(pm[1].trim()) : null;
    const periodicidade = descPer(planoLabel) || pisoPer(c.ini, c.fim);
    const status = c.statusCol || (c.fim >= new Date().toISOString().slice(0, 10) ? 'ativo' : 'encerrado');

    const aluno = { idExterno: c.idA, nome: c.nome || null };
    let responsavel = null;
    const payer = payerByAluno[c.idA];
    if (payer === 'financially_dependent') {
      // ficha do dependente (1x/aluno): id_responsavel + nasc/payer p/ o sync de PESSOA
      let fic = fichaCache.get(c.idA);
      if (!fic) {
        const fh = await get('/mod_alunos/update_alunos.php?id=' + c.idA); stats.fichas++;
        fic = { idResp: field(fh, 'id_responsavel'), tp: tpsel(fh),
                nasc: toISO(field(fh, 'data_nascimento')) || null };
        fichaCache.set(c.idA, fic);
      }
      aluno.dataNascimento = fic.nasc;
      aluno.payerRelation = payerFromTp(fic.tp) || payer;
      if (fic.idResp && fic.idResp !== '0') responsavel = { idExterno: fic.idResp };
    } else if (payer) {
      aluno.payerRelation = payer;   // self_paid (do cadastro); sem ficha extra
    }
    contratos.push({ idC: c.idC, idA: c.idA, curso: c.curso || null, status, ini: c.ini, fim: c.fim,
      planoLabel, periodicidade, aluno, responsavel });
  }
  return { contratos, stats };
}

module.exports = { kind, produce };
