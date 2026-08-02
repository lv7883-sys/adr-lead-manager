'use strict';
// meta-referral.itest.js — recordReferral/referralForConversation contra Postgres real.
// Valida gravação, dedup (first-touch por índice único) e "toque mais antigo vence".
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const metaReferral = require('../src/metaReferral');

let c;
const T1 = '00000000-0000-0000-0000-0000000000ab';
const CH = 'instagram_dm';
const PSID = '17840000000000001';

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE tenants (id uuid PRIMARY KEY, name text);
    CREATE TABLE meta_ad_referral (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text, psid text,
      ad_id text, ref text, source text, ref_type text, ads_context jsonb,
      received_at timestamptz NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX uq_meta_ad_referral ON meta_ad_referral
      (tenant_id, channel, psid, (coalesce(ad_id,'')), (coalesce(ref,'')));
  `);
  await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'ADR')`, [T1]);
});
after(async () => { await c.end(); });

async function clear() { await c.query(`DELETE FROM meta_ad_referral WHERE tenant_id=$1`, [T1]); }
async function count() { return +(await c.query(`SELECT count(*)::int n FROM meta_ad_referral WHERE tenant_id=$1`, [T1])).rows[0].n; }

test('(1) grava e consulta o toque (ad_id/ref/source/contexto)', async () => {
  await clear();
  await metaReferral.recordReferral(T1, CH, PSID, {
    adId: 'AD1', ref: 'campanha_violao', source: 'ADS', type: 'OPEN_THREAD',
    adsContext: { ad_title: 'Aulas de violão', post_id: '1_2' },
  });
  const r = await metaReferral.referralForConversation(T1, CH, PSID);
  assert.equal(r.ad_id, 'AD1');
  assert.equal(r.ref, 'campanha_violao');
  assert.equal(r.source, 'ADS');
  assert.equal(r.ref_type, 'OPEN_THREAD');
  assert.equal(r.ads_context.ad_title, 'Aulas de violão');
});

test('(2) dedup: mesmo (ad_id,ref) não duplica (first-touch mantido)', async () => {
  await clear();
  const ref = { adId: 'AD1', ref: 'x', source: 'ADS', type: 'OPEN_THREAD', adsContext: null };
  await metaReferral.recordReferral(T1, CH, PSID, ref);
  const t0 = (await metaReferral.referralForConversation(T1, CH, PSID)).received_at;
  await metaReferral.recordReferral(T1, CH, PSID, ref);   // reentrega do webhook / clique repetido
  assert.equal(await count(), 1);
  const t1 = (await metaReferral.referralForConversation(T1, CH, PSID)).received_at;
  assert.equal(t1.getTime(), t0.getTime(), 'received_at do first-touch preservado');
});

test('(3) first-touch: toque MAIS ANTIGO vence entre anúncios diferentes', async () => {
  await clear();
  // insere direto p/ controlar received_at
  await c.query(`INSERT INTO meta_ad_referral (tenant_id,channel,psid,ad_id,ref,received_at)
                 VALUES ($1,$2,$3,'AD_NOVO','novo', now()),
                        ($1,$2,$3,'AD_ANTIGO','antigo', now() - interval '10 days')`, [T1, CH, PSID]);
  const r = await metaReferral.referralForConversation(T1, CH, PSID);
  assert.equal(r.ad_id, 'AD_ANTIGO');
  assert.equal(r.ref, 'antigo');
});

test('(4) DM orgânico (sem toque) -> null', async () => {
  await clear();
  assert.equal(await metaReferral.referralForConversation(T1, CH, PSID), null);
});

test('(5) só ref (sem ad_id) grava e casa o dedup (coalesce null->"")', async () => {
  await clear();
  const ref = { adId: null, ref: 'promo_maes', source: 'SHORTLINK', type: null, adsContext: null };
  await metaReferral.recordReferral(T1, CH, PSID, ref);
  await metaReferral.recordReferral(T1, CH, PSID, ref);
  assert.equal(await count(), 1);
  const r = await metaReferral.referralForConversation(T1, CH, PSID);
  assert.equal(r.ref, 'promo_maes');
  assert.equal(r.ad_id, null);
});
