'use strict';
//
// aprendizado-ia.js — "A IA está pronta para responder sozinha?" — com dados, não com opinião.
//
//   docker exec -e DIAS=30 adr-lead-manager node scripts/aprendizado-ia.js
//   docker exec -e DIAS=30 -e TENANT=<uuid> -e AMOSTRA=1 adr-lead-manager node scripts/aprendizado-ia.js
//
// SOMENTE LEITURA. Não altera nada.
//
// Lê o que a IA propôs (migr. 176) e o que a recepção realmente enviou depois, e devolve o
// aproveitamento por contexto. A régua da comparação mora em src/aprendizado.js — aqui só se
// imprime; se alguém quiser mudar o limiar, muda lá e este relatório acompanha.
//
// COMO LER (e o que NÃO concluir):
//   • "enviou igual" alto num contexto = candidato a ligar o automático NAQUELE contexto,
//     não no atendimento inteiro. A decisão é fatiada, senão vira aposta.
//   • "editou" é o material mais valioso: mostra o que a IA quase acerta. Ler os pares.
//   • "não respondeu" NÃO entra nas taxas — não diz nada sobre o texto da IA, diz sobre o
//     atendimento. Aparece separado de propósito.
//   • Nada disso mede se a resposta VENDEU. Mede concordância com a recepção. Ler junto do funil.
//
const { withTenant, pool } = require('../src/db');
const apr = require('../src/aprendizado');

const DIAS = Number(process.env.DIAS || 30);
const AMOSTRA = process.env.AMOSTRA === '1';
const TENANT = process.env.TENANT || null;

const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : '—');

async function doTenant(tenantId) {
  const linhas = await withTenant(tenantId, (c) => c
    .query(apr.sqlSugestoesComResposta(), [tenantId, DIAS]).then((r) => r.rows));
  const r = apr.relatorio(linhas);

  console.log(`\n=== ${tenantId} — últimos ${DIAS} dias ===`);
  if (!r.total) {
    console.log('  Nenhuma sugestão registrada no período.');
    console.log('  (Se o botão "Sugerir" está em uso, confira se a migração 176 foi aplicada.)');
    return;
  }
  console.log(`  sugestões geradas ................ ${r.total}`);
  console.log(`  sem nenhuma resposta depois ...... ${r[apr.NAO_RESPONDEU]}  (fora das taxas: é sobre atendimento, não sobre a IA)`);
  console.log(`  com resposta (base das taxas) .... ${r.com_resposta}`);
  console.log('');
  console.log(`  enviou igual ..................... ${r[apr.ENVIOU_IGUAL]}  (${pct(r[apr.ENVIOU_IGUAL], r.com_resposta)})`);
  console.log(`  editou e enviou .................. ${r[apr.EDITOU]}  (${pct(r[apr.EDITOU], r.com_resposta)})`);
  console.log(`  escreveu do zero ................. ${r[apr.ESCREVEU_DO_ZERO]}  (${pct(r[apr.ESCREVEU_DO_ZERO], r.com_resposta)})`);
  console.log('');
  console.log(`  APROVEITAMENTO (igual + editado) .. ${r.aproveitamento_pct}%`);
  console.log(`  PRONTO SOZINHO (só igual) ......... ${r.igual_pct}%   ← é este que sustenta ligar o automático`);

  const ctxs = Object.entries(r.por_contexto).sort((a, b) => b[1].total - a[1].total);
  if (ctxs.length > 1) {
    console.log('\n  por contexto (é aqui que se decide o que ligar primeiro):');
    for (const [nome, c] of ctxs) {
      const base = c.total - c[apr.NAO_RESPONDEU];
      console.log(`    ${nome.padEnd(14)} n=${String(c.total).padStart(4)}  igual ${pct(c[apr.ENVIOU_IGUAL], base).padStart(6)}  editou ${pct(c[apr.EDITOU], base).padStart(6)}  do zero ${pct(c[apr.ESCREVEU_DO_ZERO], base).padStart(6)}`);
    }
  }

  if (AMOSTRA) {
    const editadas = linhas
      .map((l) => ({ l, d: apr.desfechoDaSugestao(l.sugerido, l.enviado) }))
      .filter((x) => x.d.desfecho === apr.EDITOU)
      .slice(0, 5);
    if (editadas.length) {
      console.log('\n  --- amostra de EDITADAS (o material para melhorar o prompt) ---');
      for (const { l, d } of editadas) {
        console.log(`\n  [${l.contexto || l.origem}] similaridade ${d.similaridade}`);
        console.log(`    IA:       ${String(l.sugerido).replace(/\s+/g, ' ').slice(0, 160)}`);
        console.log(`    ENVIADO:  ${String(l.enviado).replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
  }
}

(async () => {
  const tenants = TENANT ? [{ tenant_id: TENANT }] : (await pool.query('SELECT tenant_id FROM tenants_active()')).rows;
  for (const t of tenants) {
    try { await doTenant(t.tenant_id); } catch (e) { console.log(`  ERRO em ${t.tenant_id}: ${e.message}`); }
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
