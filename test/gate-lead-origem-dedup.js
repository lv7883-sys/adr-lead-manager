'use strict';
// GATE feat/lead-origem-dedup — roda o CÓDIGO REAL da branch (engine/metrics/metaIngest +
// telefoneBR) contra o DB real, num tenant sintético descartável. IA stubada (sem rede).
//   docker exec -u root -w <overlay> adr-lead-manager node test/gate-lead-origem-dedup.js
// RODAR NO CONTAINER (precisa de DB + REDIS). NÃO roda no sandbox sem DATABASE_URL.
const crypto = require('node:crypto');
const engine = require('../src/engine');
const metrics = require('../src/metrics');
const meta = require('../src/metaIngest');
const telBR = require('../src/telefoneBR');
const { withTenant, pool } = require('../src/db');
const redisClient = require('../src/redisClient');

const T = crypto.randomUUID();
const q = (sql, p) => withTenant(T, (c) => c.query(sql, p)).then((r) => r.rows);

let fails = 0;
const ok = (cond, line) => { console.log(`${cond ? 'ok  ' : 'NOT '} ${line}`); if (!cond) fails++; };

// deps: IA stubada; redis real (env do container). extract lança → caminho não-fatal.
const deps = () => ({
  classify: async () => ({ is_lead: true, confidence: 0.99, reasoning: 'stub', profile_signals: [] }),
  classifyConversa: async () => ({ is_lead: true, intent: 'NOVA_OPORTUNIDADE', confidence: 0.9 }),
  generate: async () => 'Resposta sintética da recepção.',
  classifyIntent: async () => null,
  extract: async () => { throw new Error('skip-extract'); },
  notify: async () => ({ sent: false }),
  notificar: async () => ({ sent: false }),
  redis: redisClient,
});

const leadgenMsg = (phone, lg, email) => ({
  channel: 'meta_lead_ads', externalId: phone || lg, phone, email,
  sender: 'Lead Forjado', body: 'Olá! Vim pelo anúncio.', skipTriage: true, leadgenId: lg,
  externalMessageId: 'leadgen:' + lg,
});
const waMsg = (phone, mid) => ({
  channel: 'whatsapp', externalId: phone, phone, sender: 'Cliente WA',
  body: 'Oi, tenho interesse em aula de guitarra', externalMessageId: mid,
});

async function leads() { return q('SELECT id, phone, email, status, origem, meta_leadgen_id FROM leads WHERE tenant_id=$1 ORDER BY created_at', [T]); }

(async () => {
  // ---- setup tenant sintético + assinatura ACTIVE (gating) ----
  await withTenant(T, async (c) => {
    await c.query(`INSERT INTO tenants (id,name,lead_manager_active) VALUES ($1,'GATE Origem',true)`, [T]);
    await c.query(`INSERT INTO tenant_lead_config (tenant_id,school_name,available_instruments,business_hours,notification_whatsapp)
                   VALUES ($1,'GATE',$2,'{}'::jsonb,'+5511999990000')`, [T, ['Guitarra']]);
    await c.query(`INSERT INTO tenant_subscriptions (tenant_id,feature,status,valid_until)
                   VALUES ($1,'LEAD_MANAGER','ACTIVE',now()+interval '30 days')`, [T]);
  });

  try {
    // ===== GATE: applyFieldMap extrai email do field_data (pure) =====
    ok(meta.applyFieldMap({ email: 'a@b.com', full_name: 'X', phone_number: '+551199' }, null).email === 'a@b.com',
       'EMAIL-MAP: applyFieldMap extrai email do formulário');

    // ===== GATE 1+4: Cenário A — Meta ANTES, WhatsApp DEPOIS (origem imutável) =====
    await engine.processInbound({ id: T }, leadgenMsg('+5519988887777', 'LG-A', 'maria@forj.com'), { meta_leadgen: {} }, deps());
    let L = await leads();
    ok(L.length === 1 && L[0].origem === 'meta_lead_ads', 'A1: leadgen cria lead origem=meta_lead_ads (first-touch)');
    ok(L[0].email === 'maria@forj.com', 'EMAIL: capturado no leadgen novo');

    // 2º toque: WhatsApp mesmo telefone → MESMO lead, origem NÃO muda
    await engine.processInbound({ id: T }, waMsg('+5519988887777', 'wa-A1'), {}, deps());
    L = await leads();
    ok(L.length === 1, 'A2: WhatsApp mesmo telefone NÃO duplica (mesmo lead)');
    ok(L[0].origem === 'meta_lead_ads', 'IMUTÁVEL: 2º toque WhatsApp NÃO re-origina (segue meta_lead_ads)');

    // ===== GATE 2: Cenário B — WhatsApp ANTES, Meta DEPOIS (merge, sem evento perdido) =====
    // formato DIVERGENTE de propósito: WA grava com 9º dígito (9 1111-2222);
    // leadgen chega SEM o 9 (1111-2222) — dígito pós-9 NÃO é 6-9 (caso real).
    await engine.processInbound({ id: T }, waMsg('+5519911112222', 'wa-B1'), {}, deps());
    let B = (await leads()).find((l) => l.phone && l.phone.includes('911112222'));
    ok(B && B.origem === 'whatsapp' && !B.meta_leadgen_id, 'B1: WhatsApp cria lead origem=whatsapp');
    await engine.processInbound({ id: T }, leadgenMsg('551911112222', 'LG-B', 'joao@forj.com'), { meta_leadgen: {} }, deps());
    const allB = (await leads()).filter((l) => l.phone && l.phone.includes('11112222'));
    ok(allB.length === 1, 'B2/CONV: telefone c/ e sem 9º dígito converge no MESMO lead (sem duplicata)');
    const merged = allB[0];
    ok(merged.origem === 'whatsapp', 'B3: origem fica a do first-touch (whatsapp) após merge Meta');
    ok(merged.meta_leadgen_id === 'LG-B', 'B4: meta_leadgen_id setado no merge (vínculo não se perde)');
    const ev = await q(`SELECT 1 FROM lead_eventos WHERE tenant_id=$1 AND lead_id=$2 AND tipo='meta_form_recebido'`, [T, merged.id]);
    ok(ev.length === 1, 'B5: evento meta_form_recebido registrado (evento NÃO perdido)');

    // ===== GATE: no-regression — WhatsApp puro novo entra no funil =====
    await engine.processInbound({ id: T }, waMsg('+5519933332222', 'wa-C1'), {}, deps());
    const C = (await leads()).find((l) => l.phone && l.phone.includes('93333'));
    ok(C && C.origem === 'whatsapp' && C.status === 'QUALIFYING', 'REGRESSÃO: WhatsApp novo → funil QUALIFYING, origem=whatsapp');
    const msgs = await q(`SELECT count(*)::int n FROM messages m JOIN conversations cv ON cv.id=m.conversation_id WHERE cv.tenant_id=$1 AND cv.external_id LIKE '%93333%'`, [T]);
    ok(msgs[0].n >= 2, 'REGRESSÃO: thread tem mensagem do lead + rascunho da IA');

    // ===== GATE: envio Evolution — telefone gravado é canônico BR (DDI 55 + 9º dígito ok) =====
    const metaLead = (await leads()).find((l) => l.meta_leadgen_id === 'LG-A');
    ok(/^\+55\d{11}$/.test(metaLead.phone), 'EVOLUTION: lead Meta-first gravado em +55DDD9XXXXXXXX (envio + toggle9 ok)');

    // ===== GATE: métrica de fonte lê leads.origem (Meta trabalhado via WhatsApp continua Meta) =====
    const m = await metrics.computeMetrics(T, { period: '90d' });
    const porCanal = m.bloco2_funil.por_canal;
    ok((porCanal.meta_lead_ads || 0) >= 1, 'MÉTRICA: por_canal credita meta_lead_ads (não migra pra WhatsApp no reply)');
    // filtro por fonte = meta_lead_ads retorna o lead
    const mf = await metrics.computeMetrics(T, { period: '90d', channel: 'meta_lead_ads' });
    ok(mf.total_leads >= 1, 'FILTRO: channel=meta_lead_ads retorna leads (não zero)');

  } finally {
    await withTenant(T, (c) => c.query('DELETE FROM tenants WHERE id=$1', [T])).catch(() => {});
    await redisClient.redis.quit().catch(() => {});
    await pool.end().catch(() => {});
  }

  console.log(`\n=== GATE ${fails === 0 ? 'VERDE' : 'VERMELHO (' + fails + ' falhas)'} ===`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('GATE-ERRO', e); process.exit(2); });
