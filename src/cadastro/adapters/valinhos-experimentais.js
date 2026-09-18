'use strict';
//
// valinhos-experimentais.js — ADAPTER das AULAS EXPERIMENTAIS da agenda da Extranet (migr 129).
// TODO o conhecimento da Extranet vive AQUI; o sync (sync-experimentais) e o runner são agnósticos.
// Mesmo molde de valinhos-leads: extranet-client (sessão/re-login/throttle) + advisory lock POR
// FETCH, gap FORA do lock — o clique humano e os outros syncs têm prioridade justa na fila.
//
// POR QUE EXISTE (2026-09-18): o funil do BI deduzia "a aula aconteceu" flagrando a situação
// 'Exp. Realizada' na tela de LEADS a cada 3h. Quem matriculava logo depois pulava para 'Ganhou' e
// a aula sumia — a taxa agendada→realizada saía 33% quando a agenda mostrava 63–78%. A AGENDA não
// deduz: registra cada aula com o resultado.
//
// DUAS TELAS (probes 2026-09-18):
//   1) /mod_agenda/list.php?hoje=YYYY-MM&experimental=1 — grade FullCalendar do mês. Cada aula é um
//      <div class="descAula"> com aula_edit("ID"), a marca <span class='aulaexperimental'> e o
//      resultado em <span class="destaque">…</span>. NÃO traz aluno nem telefone.
//   2) /mod_agenda/detalhar_aula.php?id=ID — formulário da aula. Linhas
//      <p class="mb-1"><strong>RÓTULO:</strong> VALOR</p> para Nome responsável, Nome aluno,
//      Telefone 1, Telefone 2, Como chegou até a escola, Data, Curso; professor e status em
//      <select> com a opção `selected`. O status vem com CÓDIGO (0,99,100,200,210,220,230,300,305,
//      310,320) — usamos o código, não o rótulo.
//
// CUSTO: cada busca espera o gap do throttle (~25s). Por isso o detalhe NÃO é relido toda vez: o
// sync decide (callback precisaDetalhe) quais aulas são novas ou mudaram de rótulo no mês.
//
const { withExtranetLock } = require('../../resources/extranet-lock');
const client = require('../../resources/adapters/extranet-client');

const kind = 'SCRAPE_EXTRANET';

const FETCH_RETRIES = Number(process.env.CADASTRO_FETCH_RETRIES ?? 4);
// Teto duro de detalhes por run: protege a Extranet de um backfill acidental enorme. O runner pode
// subir via env para a carga inicial.
const MAX_DETALHES = Number(process.env.EXTRANET_EXP_MAX_DETALHES ?? 60);
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

// Página MENSAL → [{ aulaId, rotulo }]. Só blocos de aula experimental; sem id → ignorado (não há
// como detalhar nem deduplicar, e contar sem id seria contar duas vezes a mesma aula).
function parseMes(html) {
  const out = []; const vistos = new Set();
  for (const raw of String(html || '').split('class="descAula"').slice(1)) {
    const bloco = raw.slice(0, 900);
    if (!/aulaexperimental/i.test(bloco)) continue;
    const m = bloco.match(/aula_edit\(\s*["']?(\d+)["']?\s*\)/);
    if (!m || vistos.has(m[1])) continue;
    vistos.add(m[1]);
    // O rótulo é o texto do span INTERNO de .destaque. Às vezes vem seguido de um sufixo — em aula de
    // reposição, "Realizada - <i class='… aulareposicao'>" —, e a primeira versão deste parser exigia
    // o fechamento imediato do span externo: 7 das 50 aulas de ago/2026 saíam com rótulo vazio. Rótulo
    // vazio NÃO erra a contagem (quem manda é o código do detalhe), mas é o rótulo que dispara a
    // releitura quando a aula vira "com matrícula posterior" — vazio para sempre, nunca releria.
    const d = bloco.match(/class=["']destaque["'][^>]*>\s*<span[^>]*>([^<]*)<\/span>/i)
      || bloco.match(/class=["']destaque["'][^>]*>([^<]+)/i);
    out.push({ aulaId: m[1], rotulo: d ? strip(d[1]) : '' });
  }
  return out;
}

// Página de DETALHE → { aluno, responsavel, fone1, fone2, origem, data, curso, professor,
// statusCod, statusRotulo } ou null se não parecer um detalhe de aula (sessão caída, id errado).
function parseDetalhe(html) {
  const h = dec(String(html || ''));
  if (!/name=["']?status["']?/i.test(h)) return null;
  const campo = (rotulo) => {
    const re = new RegExp(`<strong>\\s*${rotulo}\\s*:?\\s*</strong>([^<]*)`, 'i');
    const m = h.match(re);
    const v = m ? m[1].replace(/\s+/g, ' ').trim() : '';
    return v || null;
  };
  const selecionada = (nome) => {
    const sel = h.match(new RegExp(`<select[^>]*name=["']?${nome}["']?[\\s\\S]*?</select>`, 'i'));
    if (!sel) return null;
    const op = sel[0].match(/<option[^>]*value=["']?([^"'\s>]*)["']?[^>]*\bselected\b[^>]*>([^<]*)</i);
    return op ? { valor: op[1], texto: op[2].replace(/\s+/g, ' ').trim() } : null;
  };
  const st = selecionada('status');
  const prof = selecionada('id_prof_subs');
  const cod = st && /^\d+$/.test(st.valor) ? Number(st.valor) : null;
  return {
    aluno: campo('Nome aluno'),
    responsavel: campo('Nome respons[aá]vel'),
    fone1: campo('Telefone 1'),
    fone2: campo('Telefone 2'),
    origem: campo('Como chegou at[eé] a escola'),
    data: toISO(campo('Data')),
    curso: campo('Curso'),
    professor: prof ? prof.texto : null,
    statusCod: cod,
    statusRotulo: st ? st.texto : null,
  };
}

// coletar: lê as páginas mensais e, das aulas encontradas, detalha as que o sync pedir.
//   meses          — ['YYYY-MM', …]
//   precisaDetalhe — async (aulas) => [aulaId…]  (o sync consulta o banco e decide)
// Snapshot = { aulas: [{ aulaId, rotulo, competencia }], detalhes: [{ aulaId, …parseDetalhe }], stats }
async function coletar(binding, { meses = [], precisaDetalhe = async () => [] } = {}) {
  const cfg = binding.config || {};
  const senha = require('../../crypto').decrypt(cfg.credential_enc);
  if (!senha) throw new Error('valinhos-experimentais: credencial vazia/indecifrável no binding');
  const creds = { email: cfg.email, senha, perfil: cfg.perfil, unidade: cfg.unidade };

  let session = await client.getSession(creds);
  const stats = { fetches: 0, retries: 0, meses: 0, aulas: 0, detalhes_pedidos: 0, detalhes_lidos: 0, detalhes_invalidos: 0, detalhes_adiados: 0 };
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

  const aulas = [];
  for (const comp of meses) {
    if (!/^\d{4}-\d{2}$/.test(comp)) continue;
    const html = await get(`/mod_agenda/list.php?hoje=${comp}&experimental=1`);
    stats.meses++;
    for (const a of parseMes(html)) aulas.push({ ...a, competencia: comp });
  }
  stats.aulas = aulas.length;

  const pedidos = await precisaDetalhe(aulas);
  stats.detalhes_pedidos = pedidos.length;
  const lote = pedidos.slice(0, MAX_DETALHES);
  stats.detalhes_adiados = pedidos.length - lote.length;   // ficam para o próximo run
  const detalhes = [];
  for (const id of lote) {
    const html = await get(`/mod_agenda/detalhar_aula.php?id=${encodeURIComponent(id)}`);
    const d = parseDetalhe(html);
    if (!d) { stats.detalhes_invalidos++; continue; }
    detalhes.push({ aulaId: String(id), ...d });
    stats.detalhes_lidos++;
  }
  return { aulas, detalhes, stats };
}

module.exports = { kind, coletar, parseMes, parseDetalhe };
