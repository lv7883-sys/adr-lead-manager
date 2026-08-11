'use strict';
//
// probe-valinhos-leads.js — PROBE one-shot READ-ONLY da tela de leads da Extranet (mod_leads).
// Objetivo: capturar o HTML real (lista + paginação + edição de UM lead) para calibrar o parser
// do adapter valinhos-leads. NUNCA roda pelo cron; rodar manualmente 1x:
//   docker exec adr-lead-manager node /app/src/cadastro/adapters/probe-valinhos-leads.js
// Saída: /app/uploads/.probe/leads-*.html + resumo no stdout (endpoint, params, Situações).
// Só GET — escrever na Extranet é proibido (regra do projeto).
//
const fs = require('node:fs');
const path = require('node:path');
const { pool, withTenant } = require('../../db');
const { withExtranetLock } = require('../../resources/extranet-lock');
const client = require('../../resources/adapters/extranet-client');

const OUT_DIR = process.env.PROBE_OUT_DIR || '/app/uploads/.probe';

async function firstBinding() {
  const { rows: tenants } = await pool.query('SELECT tenant_id FROM tenants_active()');
  for (const { tenant_id: tenantId } of tenants) {
    const { rows } = await withTenant(tenantId, (c) => c.query(
      `SELECT id, kind, config FROM resources.resource_source_binding
        WHERE status='ACTIVE' AND kind='SCRAPE_EXTRANET' ORDER BY created_at LIMIT 1`));
    if (rows[0]) return { tenantId, binding: rows[0] };
  }
  throw new Error('nenhum binding SCRAPE_EXTRANET ativo');
}

// <select name=X> → { name, options: [{value, label}] } (mesmo decode manual dos adapters)
const dec = (s) => String(s || '')
  .replace(/&ccedil;/g, 'ç').replace(/&atilde;/g, 'ã').replace(/&otilde;/g, 'õ').replace(/&aacute;/g, 'á')
  .replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í').replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú')
  .replace(/&acirc;/g, 'â').replace(/&ecirc;/g, 'ê').replace(/&ocirc;/g, 'ô').replace(/&agrave;/g, 'à')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
function selects(html) {
  const out = [];
  for (const m of html.matchAll(/<select[^>]*name=["']([^"']+)["'][\s\S]*?<\/select>/gi)) {
    const options = [...m[0].matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>([^<]*)</gi)]
      .map((o) => ({ value: o[1], label: dec(o[2]).trim() }));
    out.push({ name: m[1], options });
  }
  return out;
}
function inputs(html) {
  return [...html.matchAll(/<input[^>]*name=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
}

const t0 = Date.now();
const log = (...a) => console.log(`[probe +${Math.round((Date.now() - t0) / 1000)}s]`, ...a);

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log('resolvendo binding SCRAPE_EXTRANET…');
  const { tenantId, binding } = await firstBinding();
  const cfg = binding.config || {};
  const senha = require('../../crypto').decrypt(cfg.credential_enc);
  if (!senha) throw new Error('credencial vazia/indecifrável no binding');
  const creds = { email: cfg.email, senha, perfil: cfg.perfil, unidade: cfg.unidade };
  log('binding ok (tenant', tenantId + '); resolvendo sessão (login Keycloak se não houver cache — pode levar ~1-2min)…');
  let session = await client.getSession(creds);
  log('sessão ok; iniciando fetches (gap ≥25s entre cada um, anti-WAF)…');

  const get = async (p) => {
    log('aguardando gap + advisory lock para GET', p);
    await client.throttleGap();
    try {
      return await withExtranetLock(() => client.fetchAuthed(p, session, { noGap: true }));
    } catch (e) {
      if (/expirad|login|redirect|SESSION_EXPIRED/i.test(e.message)) {
        session = await client.getSession(creds, { force: true });
        await client.throttleGap();
        return withExtranetLock(() => client.fetchAuthed(p, session, { noGap: true }));
      }
      throw e;
    }
  };
  const save = (name, html) => {
    fs.writeFileSync(path.join(OUT_DIR, name), html);
    log(`salvo ${name} (${html.length} bytes)`);
  };

  // 1) A tela da lista (revela form de filtro, action e o mecanismo de paginação)
  const tela = await get('/mod_leads/lista_todos_leads.php');
  save('leads-tela.html', tela);
  console.log('[probe] tenant:', tenantId);
  console.log('[probe] inputs do form:', JSON.stringify(inputs(tela)));
  for (const s of selects(tela)) console.log(`[probe] select "${s.name}":`, JSON.stringify(s.options));
  const actions = [...tela.matchAll(/(?:action|href|url|open)\s*[:=(]\s*["']([^"']*mod_leads[^"']*)["']/gi)].map((m) => m[1]);
  console.log('[probe] referências mod_leads na tela:', JSON.stringify([...new Set(actions)]));

  // 2) Endpoint de paginação: monta_lista.php se referenciado (padrão da casa), senão a própria tela com pg
  const montaRef = actions.find((a) => /monta_lista\.php/i.test(a));
  const pgPath = montaRef
    ? `/mod_leads/monta_lista.php?pg=1&num_por_pagina=500&nome=&curso=&status=`
    : `/mod_leads/lista_todos_leads.php?pg=1&num_por_pagina=500&nome=&curso=&status=`;
  const pg1 = await get(pgPath);
  save('leads-pg1.html', pg1);
  console.log('[probe] paginação usada:', pgPath);
  console.log('[probe] <tr> na pg1:', (pg1.match(/<tr/gi) || []).length);

  // 3) Tela de edição de UM lead (se a linha trouxer link com id)
  const edit = (pg1.match(/["']([^"']*mod_leads[^"']*(?:update|edit|detalh)[^"']*\bid=\d+[^"']*)["']/i)
    || pg1.match(/["']([^"']*\bid=\d+[^"']*)["']/i) || [])[1];
  if (edit) {
    const p = edit.startsWith('/') ? edit : `/mod_leads/${edit.replace(/^\.\//, '')}`;
    const h = await get(p.replace(/&amp;/g, '&'));
    save('leads-edit.html', h);
    console.log('[probe] edição capturada de:', p);
  } else {
    console.log('[probe] NENHUM link de edição com id encontrado na pg1 — inspecionar leads-pg1.html');
  }
  console.log('[probe] concluído. Arquivos em', OUT_DIR);
}

main().then(() => process.exit(0)).catch((e) => { console.error('[probe] ERRO:', e.message); process.exit(1); });
