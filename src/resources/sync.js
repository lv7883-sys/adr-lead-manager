'use strict';

// sync.js — CORE GENÉRICO do Sincronizador de Recursos (ADR-026 §2.2/§2.3).
//
// FRONTEIRA (ADR-026 §2.6): este arquivo NÃO conhece a fonte. Opera só sobre o
// ResourceSnapshot genérico (snapshot.js). NÃO contém nenhuma string específica de
// adapter — nomes de endpoint, identificadores da fonte, rótulos de status ou
// mapeamentos de domínio ficam todos no adapter. Se algo disso vazar para cá, o
// teste de fronteira (test/resources-sync.itest.js) falha.
//
// Recebe um `client` JÁ em transação com `app.current_tenant` setado (db.withTenant),
// de modo que toda escrita roda sob a RLS por tenant do schema `resources` (046).

const { validateSnapshot } = require('./snapshot');

/**
 * Sincroniza o schema `resources` com um snapshot genérico da fonte.
 * Idempotente: rodar 2x com o mesmo snapshot não duplica nem altera nada na 2ª.
 *
 * @param {import('pg').PoolClient} client  já em transação + app.current_tenant
 * @param {{ tenantId: string, sourceBindingId: string, snapshot: object }} arg
 * @returns {Promise<object>} estatísticas da execução
 */
async function syncResources(client, { tenantId, sourceBindingId, snapshot }) {
  validateSnapshot(snapshot);
  const stats = {
    capabilities: { inserted: 0, updated: 0 },
    resources: { inserted: 0, updated: 0, reactivated: 0, softDeleted: 0 },
    links: { inserted: 0, deleted: 0 },
    availability: { inserted: 0, deleted: 0 },
  };

  // ----- 1) capabilities: upsert por external_ref -----
  const capId = new Map();
  for (const cap of snapshot.capabilities) {
    const r = await client.query(
      `INSERT INTO resources.capability (tenant_id, external_ref, name, source_binding_id)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, external_ref) WHERE external_ref IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [tenantId, cap.ref, cap.name, sourceBindingId],
    );
    capId.set(cap.ref, r.rows[0].id);
    r.rows[0].inserted ? stats.capabilities.inserted++ : stats.capabilities.updated++;
  }

  // ----- 2) resources: upsert por (type, external_ref) + soft-delete dos ausentes -----
  // Estado anterior (mesmo binding) p/ detectar reativação e soft-delete.
  const prev = await client.query(
    `SELECT id, type, external_ref, active
       FROM resources.resource
      WHERE tenant_id = $1 AND source_binding_id = $2`,
    [tenantId, sourceBindingId],
  );
  const prevByKey = new Map(prev.rows.map((x) => [`${x.type}|${x.external_ref}`, x]));

  const resId = new Map();
  const presentKeys = new Set();
  for (const res of snapshot.resources) {
    const key = `${res.type}|${res.ref}`;
    presentKeys.add(key);
    const before = prevByKey.get(key);
    const r = await client.query(
      `INSERT INTO resources.resource
              (tenant_id, type, external_ref, name, attributes, source_binding_id, active)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, true)
       ON CONFLICT (tenant_id, type, external_ref) WHERE external_ref IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name,
                     attributes = EXCLUDED.attributes,
                     source_binding_id = EXCLUDED.source_binding_id,
                     active = true,
                     updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [tenantId, res.type, res.ref, res.name, JSON.stringify(res.attributes || {}), sourceBindingId],
    );
    resId.set(key, r.rows[0].id);
    if (r.rows[0].inserted) stats.resources.inserted++;
    else {
      stats.resources.updated++;
      if (before && before.active === false) stats.resources.reactivated++;
    }
  }

  // soft-delete: presente no banco (active=true) e ausente no snapshot → active=false.
  // NÃO deleta linha nem disponibilidade (histórico preservado §2.3). O recurso
  // desativado sai da busca de encaixe porque toda consulta filtra active=true.
  for (const [key, row] of prevByKey) {
    if (!presentKeys.has(key) && row.active) {
      await client.query(
        `UPDATE resources.resource SET active = false, updated_at = now() WHERE id = $1`,
        [row.id],
      );
      stats.resources.softDeleted++;
    }
  }

  // ----- 3) resource_capability: por recurso, sincroniza vínculos (insert faltantes / delete extras) -----
  for (const res of snapshot.resources) {
    const rid = resId.get(`${res.type}|${res.ref}`);
    const wantIds = (res.capabilityRefs || []).map((ref) => capId.get(ref)).filter(Boolean);

    if (wantIds.length) {
      const del = await client.query(
        `DELETE FROM resources.resource_capability
          WHERE tenant_id = $1 AND resource_id = $2 AND capability_id <> ALL($3::uuid[])`,
        [tenantId, rid, wantIds],
      );
      stats.links.deleted += del.rowCount;
      for (const cid of wantIds) {
        const ins = await client.query(
          `INSERT INTO resources.resource_capability (tenant_id, resource_id, capability_id)
                VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, resource_id, capability_id) DO NOTHING`,
          [tenantId, rid, cid],
        );
        stats.links.inserted += ins.rowCount;
      }
    } else {
      const del = await client.query(
        `DELETE FROM resources.resource_capability WHERE tenant_id = $1 AND resource_id = $2`,
        [tenantId, rid],
      );
      stats.links.deleted += del.rowCount;
    }
  }

  // ----- 4) resource_availability: por recurso, sincroniza por (weekday,start,end) -----
  for (const res of snapshot.resources) {
    const rid = resId.get(`${res.type}|${res.ref}`);
    const want = (res.availability || []).map((a) => ({ wd: a.weekday, s: a.start, e: a.end }));

    const cur = await client.query(
      `SELECT id, weekday, to_char(start_time,'HH24:MI') AS s, to_char(end_time,'HH24:MI') AS e
         FROM resources.resource_availability
        WHERE tenant_id = $1 AND resource_id = $2`,
      [tenantId, rid],
    );
    const curKeys = new Map(cur.rows.map((x) => [`${x.weekday}|${x.s}|${x.e}`, x.id]));
    const wantKeys = new Set(want.map((w) => `${w.wd}|${w.s}|${w.e}`));

    for (const [k, id] of curKeys) {
      if (!wantKeys.has(k)) {
        await client.query(`DELETE FROM resources.resource_availability WHERE id = $1`, [id]);
        stats.availability.deleted++;
      }
    }
    for (const w of want) {
      if (!curKeys.has(`${w.wd}|${w.s}|${w.e}`)) {
        await client.query(
          `INSERT INTO resources.resource_availability
                  (tenant_id, resource_id, weekday, start_time, end_time, source_binding_id)
                VALUES ($1, $2, $3, $4::time, $5::time, $6)`,
          [tenantId, rid, w.wd, w.s, w.e, sourceBindingId],
        );
        stats.availability.inserted++;
      }
    }
  }

  return stats;
}

module.exports = { syncResources };
