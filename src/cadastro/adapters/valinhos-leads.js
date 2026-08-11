'use strict';
//
// valinhos-leads.js — ADAPTER de LEADS da fonte SCRAPE_EXTRANET (mod_leads, migr 102).
// TODO o conhecimento da Extranet vive AQUI (regexes, telas, params). Runner/sync são agnósticos.
// Reusa o extranet-client (sessão/re-login/throttle) + advisory lock POR FETCH (molde
// valinhos-contratos: gap FORA do lock, clique humano tem prioridade na fila).
//
// TELA (probe 2026-08-11): /mod_leads/lista_todos_leads.php?pg=N&palavra=&vencido=0&curso=&statusA=&motivo=&npg=50
//   — params EXATOS do JS da própria tela (função de busca); npg máximo = 50; sem endpoint monta_lista.
//   Linha: <tr> com id em contato_edit(<id>); tds = [0]=data<br/>hora [1]=Nome/fone visível/Curso/Prof
//   [2]=badge Situação [3]=Últ.Contato [4]=Próx.Contato [5]=ações. Fone: usar o TEXTO visível
//   "(19)99422-8953" — o href do wa.me vem com DDD 0-prefixado (55019...) que quebraria a chave.
//   Situações (select statusA): Pendente, Conexão, Exp. Agendada, Exp. Realizada, Exp. Cancelada,
//   Ganhou, Perdeu, Sem Retorno, Stand By, Desqualificado.
//
// JANELA DESLIZANTE (decisão 2026-08-11): a lista guarda TODO o histórico (100+ páginas, ~1500
// leads) — importar tudo é a E11 (Fase 2). O sync acompanha só a janela recente
// (EXTRANET_LEADS_WINDOW_DIAS, default 90): pagina em ordem decrescente de data e PARA quando a
// página inteira fica mais velha que o corte. windowStart segue no snapshot — espelho/soft-delete/
// salvaguarda operam DENTRO da janela (fora dela o espelho não é tocado).
//
const { withExtranetLock } = require('../../resources/extranet-lock');
const client = require('../../resources/adapters/extranet-client');

const kind = 'SCRAPE_EXTRANET';

const WINDOW_DIAS = Number(process.env.EXTRANET_LEADS_WINDOW_DIAS ?? 90);
const MAX_PAGES = Number(process.env.EXTRANET_LEADS_MAX_PAGES ?? 12);   // teto duro (12×50=600 leads)
const NPG = 50;                                                          // máximo que a tela aceita

const FETCH_RETRIES = Number(process.env.CADASTRO_FETCH_RETRIES ?? 4);
const _TRANSIENT_CODES = new Set(['BLOCK', 'TIMEOUT', 'SESSION_EXPIRED', 'NETWORK', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET']);
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function _isTransient(e) {
  if (e && _TRANSIENT_CODES.has(e.code)) return true;
  return /cooldown|rate|429|fetch failed|network|socket|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|timeout de \d+s/i.test((e && e.message) || '');
}

// ---- parse helpers (mesmo decode manual latin dos adapters irmãos) ----
const dec = (s) => String(s || '')
  .replace(/&ccedil;/g, 'ç').replace(/&atilde;/g, 'ã').replace(/&otilde;/g, 'õ').replace(/&aacute;/g, 'á')
  .replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í').replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú')
  .replace(/&acirc;/g, 'â').replace(/&ecirc;/g, 'ê').replace(/&ocirc;/g, 'ô').replace(/&agrave;/g, 'à')
  .replace(/&ordm;/g, 'º').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const strip = (s) => dec(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const toISO = (br) => { const m = String(br || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

// "08/07/2026<br/>08:56:37" → timestamptz ISO com offset fixo de São Paulo (sem DST desde 2019).
function toTs(td) {
  const d = toISO(td);
  if (!d) return null;
  const h = (String(td).match(/(\d{2}:\d{2}:\d{2})/) || [])[1] || '00:00:00';
  return `${d}T${h}-03:00`;
}

// PARSER PURO da lista (exportado p/ teste unit sobre fixture). Uma entrada por contato_edit(id).
function parseLista(html) {
  const out = [];
  const rows = String(html || '').split(/<tr\b/i).filter((r) => /contato_edit\(\d+\)/i.test(r));
  for (const r of rows) {
    const extranetId = (r.match(/contato_edit\((\d+)\)/i) || [])[1];
    if (!extranetId) continue;
    const tds = r.match(/<td[\s\S]*?<\/td>/gi) || [];
    const info = tds[1] || '';
    const nome = strip((info.match(/Nome:<\/strong>([\s\S]*?)(?:<br|<small|$)/i) || [])[1]);
    // fone: o TEXTO visível do link do WhatsApp (o param do href tem DDD 0-prefixado — não usar)
    const foneRaw = strip((info.match(/<\/i>\s*([^<]+)<\/a>/i) || [])[1]) || null;
    const curso = strip((info.match(/Curso:<\/strong>([\s\S]*?)(?:<br|<strong|$)/i) || [])[1]) || null;
    const professor = strip((info.match(/Professor(?:\(a\))?:<\/strong>([\s\S]*?)(?:<br|<strong|$)/i) || [])[1]) || null;
    out.push({
      extranetId,
      nome: nome || null,
      foneRaw,
      curso,
      professor,
      situacao: strip((r.match(/<span[^>]*badge[^>]*>([\s\S]*?)<\/span>/i) || [])[1]) || null,
      dataCadastro: toTs(strip(tds[0] ? tds[0].replace(/<br\s*\/?/i, ' ') : '')),
      ultContato: toISO(strip(tds[3])),
      proxContato: toISO(strip(tds[4])),
    });
  }
  return out;
}

// produce: lista paginada DESC por data, dentro da janela. Snapshot = { leads, windowStart, stats }.
async function produce(binding, { tenantId } = {}) {
  const cfg = binding.config || {};
  const senha = require('../../crypto').decrypt(cfg.credential_enc);
  if (!senha) throw new Error('valinhos-leads: credencial vazia/indecifrável no binding');
  const creds = { email: cfg.email, senha, perfil: cfg.perfil, unidade: cfg.unidade };

  let session = await client.getSession(creds);
  const stats = { fetches: 0, retries: 0, paginas: 0 };
  const get = async (path) => {
    let lastErr;
    for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
      await client.throttleGap();
      try {
        const r = await withExtranetLock(() => client.fetchAuthed(path, session, { noGap: true }));
        stats.fetches++;
        return r;
      } catch (e) {
        lastErr = e;
        if (/expirad|login|redirect|SESSION_EXPIRED/i.test(e.message)) {
          session = await client.getSession(creds, { force: true });
          continue;
        }
        if (!_isTransient(e) || attempt === FETCH_RETRIES) throw e;
        stats.retries++;
        await _sleep(Math.min(60000, 5000 * 2 ** attempt));
      }
    }
    throw lastErr;
  };

  const windowStart = new Date(Date.now() - WINDOW_DIAS * 864e5).toISOString().slice(0, 10);
  const leads = []; const seen = new Set();
  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    const h = await get(`/mod_leads/lista_todos_leads.php?pg=${pg}&palavra=&vencido=0&curso=&statusA=&motivo=&npg=${NPG}`);
    const rows = parseLista(h);
    stats.paginas++;
    let novos = 0;
    for (const r of rows) {
      if (seen.has(r.extranetId)) continue;
      seen.add(r.extranetId); novos++;
      // dentro da janela (sem data parseável = defensivo: entra)
      if (!r.dataCadastro || r.dataCadastro.slice(0, 10) >= windowStart) leads.push(r);
    }
    if (rows.length === 0 || novos === 0) break;                       // acabou a lista
    // página INTEIRA mais velha que o corte → (ordem desc) o resto é histórico, para
    if (rows.every((r) => r.dataCadastro && r.dataCadastro.slice(0, 10) < windowStart)) break;
  }
  return { leads, windowStart, stats };
}

module.exports = { kind, produce, parseLista };
