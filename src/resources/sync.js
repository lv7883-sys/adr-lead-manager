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

// Canonicaliza p/ comparar jsonb de forma estável (jsonb NÃO preserva ordem de chave):
// ordena chaves recursivamente antes de serializar. Evita falso-positivo de "mudou".
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((a, k) => { a[k] = canon(v[k]); return a; }, {});
  return v;
};
const canonStr = (v) => JSON.stringify(canon(v || {}));

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

  // ----- 1) capabilities: DIFF-BASED por external_ref -----
  // existe e mudou (nome) → UPDATE; existe e idêntico → pula (updated_at intacto); não existe → INSERT.
  const capId = new Map();
  const prevCaps = await client.query(
    `SELECT id, external_ref, name FROM resources.capability
      WHERE tenant_id = $1 AND external_ref IS NOT NULL`,
    [tenantId],
  );
  const prevCapByRef = new Map(prevCaps.rows.map((x) => [x.external_ref, x]));
  for (const cap of snapshot.capabilities) {
    const before = prevCapByRef.get(cap.ref);
    if (!before) {
      const r = await client.query(
        `INSERT INTO resources.capability (tenant_id, external_ref, name, source_binding_id)
              VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, cap.ref, cap.name, sourceBindingId],
      );
      capId.set(cap.ref, r.rows[0].id);
      stats.capabilities.inserted++;
    } else {
      capId.set(cap.ref, before.id);
      if (before.name !== cap.name) {
        await client.query(
          `UPDATE resources.capability SET name = $2, updated_at = now() WHERE id = $1`,
          [before.id, cap.name],
        );
        stats.capabilities.updated++;
      }
    }
  }

  // ----- 2) resources: DIFF-BASED por (type, external_ref) + soft-delete dos ausentes -----
  // Estado anterior do TENANT (a unicidade é por tenant, não por binding) p/ detectar
  // mudança/reativação; o soft-delete abaixo restringe ao binding corrente.
  const prev = await client.query(
    `SELECT id, type, external_ref, name, attributes, active, source_binding_id
       FROM resources.resource
      WHERE tenant_id = $1`,
    [tenantId],
  );
  const prevByKey = new Map(prev.rows.map((x) => [`${x.type}|${x.external_ref}`, x]));

  const resId = new Map();
  const presentKeys = new Set();
  for (const res of snapshot.resources) {
    const key = `${res.type}|${res.ref}`;
    presentKeys.add(key);
    const before = prevByKey.get(key);
    const attrsJson = JSON.stringify(res.attributes || {});
    if (!before) {
      const r = await client.query(
        `INSERT INTO resources.resource
                (tenant_id, type, external_ref, name, attributes, source_binding_id, active)
              VALUES ($1, $2, $3, $4, $5::jsonb, $6, true)
         RETURNING id`,
        [tenantId, res.type, res.ref, res.name, attrsJson, sourceBindingId],
      );
      resId.set(key, r.rows[0].id);
      stats.resources.inserted++;
    } else {
      resId.set(key, before.id);
      const changed =
        before.name !== res.name ||
        canonStr(before.attributes) !== canonStr(res.attributes) ||
        before.active !== true ||
        before.source_binding_id !== sourceBindingId;
      if (changed) {                                  // só toca a linha se algo mudou de fato
        await client.query(
          `UPDATE resources.resource
              SET name = $2, attributes = $3::jsonb, source_binding_id = $4, active = true, updated_at = now()
            WHERE id = $1`,
          [before.id, res.name, attrsJson, sourceBindingId],
        );
        stats.resources.updated++;
        if (before.active === false) stats.resources.reactivated++;
      }
    }
  }

  // soft-delete: presente no banco (active=true) e ausente no snapshot → active=false.
  // NÃO deleta linha nem disponibilidade (histórico preservado §2.3). O recurso
  // desativado sai da busca de encaixe porque toda consulta filtra active=true.
  for (const [key, row] of prevByKey) {
    if (row.source_binding_id === sourceBindingId && row.active && !presentKeys.has(key)) {
      await client.query(
        `UPDATE resources.resource SET active = false, updated_at = now() WHERE id = $1`,
        [row.id],
      );
      stats.resources.softDeleted++;
    }
  }

  // ----- 3) resource_capability: por recurso, sincroniza vínculos (insert faltantes / delete extras) -----
  // FRONTEIRA (ADR-026): o sync só gerencia vínculos de recursos cujas capabilities VÊM DA
  // FONTE — ou seja, cujo snapshot traz `capabilityRefs` como ARRAY (competência de TEACHER).
  // Recurso SEM o campo (capabilityRefs undefined) tem o vínculo gerido por HUMANO, fora do
  // alcance do sync: é o caso da SALA (vocação sala↔capability, atribuída na tela — parseSala
  // devolve sem capabilityRefs). NUNCA tocamos (delete/insert) o vínculo desses. A distinção é
  // por AUSÊNCIA do campo, não por length: `[]` (lista vazia explícita, ex.: TEACHER que perdeu
  // todas as caps na fonte) SEGUE gerenciado e seus vínculos são removidos.
  for (const res of snapshot.resources) {
    if (!Array.isArray(res.capabilityRefs)) continue; // ROOM (vocação humana) → sync não gerencia

    const rid = resId.get(`${res.type}|${res.ref}`);
    const wantIds = res.capabilityRefs.map((ref) => capId.get(ref)).filter(Boolean);

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
