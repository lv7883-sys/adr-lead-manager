'use strict';
//
// probe-valinhos-leads.js — PROBE one-shot READ-ONLY da tela de leads da Extranet (mod_leads).
// v2 (diagnóstico): compara a lista SEM parâmetros (o que o navegador mostra) com a URL
// paginada que o adapter usa — o run inicial veio sem nenhum 'Exp. Agendada', suspeita de
// que os params retornam um SUBCONJUNTO. NUNCA roda pelo cron; rodar manualmente:
//   docker exec adr-lead-manager node /app/src/cadastro/adapters/probe-valinhos-leads.js
// Só GET — escrever na Extranet é proibido (regra do projeto).
//
const fs = require('node:fs');
const path = require('node:path');
const { pool, withTenant } = require('../../db');
const { withExtranetLock } = require('../../resources/extranet-lock');
const client = require('../../resources/adapters/extranet-client');
const { parseLista } = require('./valinhos-leads');

const OUT_DIR = process.env.PROBE_OUT_DIR || '/app/uploads/.probe';
const t0 = Date.now();
const log = (...a) => console.log(`[probe +${Math.round((Date.now() - t0) / 1000)}s]`, ...a);

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

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { binding } = await firstBinding();
  const cfg = binding.config || {};
  const senha = require('../../crypto').decrypt(cfg.credential_enc);
  if (!senha) throw new Error('credencial vazia/indecifrável no binding');
  const creds = { email: cfg.email, senha, perfil: cfg.perfil, unidade: cfg.unidade };
  log('resolvendo sessão…');
  let session = await client.getSession(creds);
  log('sessão ok');

  const get = async (p) => {
    log('GET', p);
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
  const dump = (rows, label) => {
    console.log(`\n== ${label}: ${rows.length} linhas ==`);
    for (const r of rows.slice(0, 20)) {
      console.log(` ${r.extranetId} | ${(r.dataCadastro || '').slice(0, 16)} | ${(r.situacao || '?').padEnd(15)} | ${r.nome}`);
    }
  };

  // (a) a tela como o navegador vê (sem params)
  const tela = await get('/mod_leads/lista_todos_leads.php');
  fs.writeFileSync(path.join(OUT_DIR, 'diag-tela.html'), tela);
  dump(parseLista(tela), 'SEM params (navegador)');

  // (b) a URL exata do adapter (pg1, npg=50, params completos do JS da tela)
  const sync1 = await get('/mod_leads/lista_todos_leads.php?pg=1&palavra=&vencido=0&curso=&statusA=&motivo=&npg=50');
  fs.writeFileSync(path.join(OUT_DIR, 'diag-sync-pg1.html'), sync1);
  dump(parseLista(sync1), 'URL do adapter (pg=1, npg=50)');

  // (c) variação: só pg+npg (sem os filtros vazios) — isola qual param muda o resultado
  const min1 = await get('/mod_leads/lista_todos_leads.php?pg=1&npg=50');
  fs.writeFileSync(path.join(OUT_DIR, 'diag-min-pg1.html'), min1);
  dump(parseLista(min1), 'mínima (pg=1&npg=50)');

  log('concluído. HTMLs em', OUT_DIR);
}

main().then(() => process.exit(0)).catch((e) => { console.error('[probe] ERRO:', e.message); process.exit(1); });
