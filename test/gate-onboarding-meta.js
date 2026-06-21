'use strict';
//
// gate-onboarding-meta.js — GATE E2E (bloqueante) do onboarding de Página Meta.
// RODAR NO CONTAINER DEPLOYADO (precisa de DB + envs Meta). NÃO roda no sandbox de dev.
//
//   docker exec -it adr-lead-manager node test/gate-onboarding-meta.js <TENANT_ID_DO_ADR>
//
// Pré-condição: ter feito start->login FLB->callback ao menos uma vez p/ esse tenant
// (conectado a Página do próprio ADR, app em modo dev). Este script CHECA o estado
// resultante e a consistência da dupla-escrita + inscrição leadgen. Não escreve nada.
//
const assert = require('node:assert');
const { withTenant } = require('../src/db');
const { decrypt } = require('../src/crypto');
const onb = require('../src/onboardingMeta');

const tenantId = process.argv[2];
if (!tenantId) { console.error('uso: node test/gate-onboarding-meta.js <TENANT_ID>'); process.exit(2); }

async function main() {
  const checks = [];
  const ok = (name, cond, extra) => { checks.push({ name, pass: !!cond, extra }); };

  // Lê o estado persistido (sob RLS do tenant).
  const row = await withTenant(tenantId, (c) =>
    c.query('SELECT meta_page_id, meta_page_token_enc, meta_ig_id FROM tenants WHERE id = $1', [tenantId]).then((r) => r.rows[0])
  );
  const src = await withTenant(tenantId, (c) =>
    c.query("SELECT entity_id, entity_kind, active FROM tenant_lead_source WHERE tenant_id = $1 AND platform = 'meta' AND entity_kind = 'fb_page' AND active", [tenantId]).then((r) => r.rows)
  );

  // [1] credenciais gravadas + token decifra de volta
  const token = row ? decrypt(row.meta_page_token_enc) : '';
  ok('tenants.meta_page_token_enc grava e decifra p/ token válido', !!(row && row.meta_page_id && token && token.length > 20),
     { page_id: row && row.meta_page_id, token_len: token.length });

  // [2] tenant_lead_source tem a linha ativa
  const srcRow = src.find((s) => s.entity_id === (row && row.meta_page_id));
  ok("tenant_lead_source (meta, fb_page, page_id, active=true) na mesma origem", !!srcRow,
     { rows: src.length });

  // [3] dupla-escrita consistente — pendência do Item 1 resolvida
  ok('tenants.meta_page_id == tenant_lead_source.entity_id', !!(srcRow && row && srcRow.entity_id === row.meta_page_id),
     { tenants: row && row.meta_page_id, source: srcRow && srcRow.entity_id });

  // [4] só UMA fb_page ativa (reconectar idempotente / página trocada desativa a antiga)
  ok('exatamente 1 fb_page ativa (idempotente, sem duplicar)', src.length === 1, { ativas: src.length });

  // [5] inscrição leadgen confirmada (checagem viva via Graph)
  const status = await onb.connectionStatus(tenantId);
  ok('subscribed_apps confirma leadgen inscrito', status.connected && status.leadgen_subscribed === true, status);

  // [6] resolução antiga intacta — o page_id resolve de volta pro tenant (caminho da ingestão)
  const meta = require('../src/meta');
  const resolved = await meta.tenantByPageId(row && row.meta_page_id);
  ok('resolução/ingestão intacta: page_id -> tenant correto', resolved === tenantId, { resolved });

  // Relatório
  let allPass = true;
  for (const c of checks) {
    allPass = allPass && c.pass;
    console.log(`${c.pass ? '✅' : '❌'} ${c.name}` + (c.extra ? `  ${JSON.stringify(c.extra)}` : ''));
  }
  console.log(allPass ? '\nGATE VERDE — pode deployar.' : '\nGATE VERMELHO — NÃO deploya.');
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('gate erro:', e.message); process.exit(1); });
