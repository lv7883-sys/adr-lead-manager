'use strict';

// scrape-extranet.js — ADAPTER de dispatch da fonte SCRAPE_EXTRANET (ADR-026 §2.4).
// Cola: binding (credencial cifrada) → extranet-client (login/sessão/throttle) →
// valinhos (fetch+parse) → ResourceSnapshot genérico. É o que o runner chama p/
// kind='SCRAPE_EXTRANET'. ESPECÍFICO da fonte (camada de adapter) — o core não o conhece.

const crypto = require('../../crypto');
const { withTenant } = require('../../db');
const { withExtranetLock } = require('../extranet-lock');
const client = require('./extranet-client');
const valinhos = require('./valinhos');

// produce(binding, { destDir }) → ResourceSnapshot. Decifra a credencial do binding
// (Opção A: LM_ENCRYPTION_KEY), monta o transporte autenticado e bate na fonte.
// PRESSUPÕE estar sob o pg_advisory_lock (responsabilidade do runner) — todo o acesso
// à Extranet (login + fetch) acontece aqui dentro.
async function produce(binding, { destDir } = {}) {
  const cfg = binding.config || {};
  const senha = crypto.decrypt(cfg.credential_enc); // só em memória; nunca a log/disco
  if (!senha) throw new Error('scrape-extranet: credencial vazia/indecifrável no binding');

  const creds = { email: cfg.email, senha, perfil: cfg.perfil, unidade: cfg.unidade };
  const transport = client.transportFor(creds);     // resolve sessão (disco/login) + re-login 1x
  const dirs = await valinhos.fetch(transport, { destDir });
  return valinhos.parse(dirs);                        // ResourceSnapshot genérico
}

// ---------------------------------------------------------------------------
// captureHistory — SNAPSHOT DIÁRIO do occupation_history (ADR-025 emenda, fatia 048).
// Roda DENTRO do daily-sync, DEPOIS do catálogo. APPEND-ONLY + DIFF-BASED + GENÉRICO.
//
// RELAÇÃO CORRETA (confirmada por investigação): buscar_lista (resource_availability) =
// LIVRE recorrente (a Extranet já desconta as fixas); api-salas-grade = OCUPADO datado.
// São COMPLEMENTARES. Por isso a ocupação vem DIRETO DA GRADE (a grade É o ocupado),
// NÃO de cruzar com o availability (o cruzamento de antes estava errado).
//
// JANELA: a PRÓXIMA OCORRÊNCIA de cada weekday de trabalho (1..6) → 6 fetches/dia,
// prospectivo. Gap FORA do lock (lock retido só no GET, ~0,5s).
//
// GRÃO: (professor) × (capability que ele OFERECE) × weekday × slot_time.
//
// ⚠️ SEMÂNTICA P/ O PAINEL — LER COMO CAPACIDADE, NÃO DEMANDA: `occupied=true` significa que o
//   PROFESSOR está OCUPADO naquele horário (capacidade consumida). Como ele não dá duas aulas
//   ao mesmo tempo, marcamos occupied em TODAS as capabilities dele naquele slot. Logo
//   "ocupação de violão" = CAPACIDADE de violão consumida (profs de violão indisponíveis),
//   NÃO "nº de aulas de violão dadas". Demanda por instrumento é OUTRO eixo (ADR próprio).
//
// ⚠️ APROXIMAÇÃO (decisão consciente): o professor da aula vem por NAME-MATCH (matchTeacher,
//   prefixo ancorado) — métrica de TENDÊNCIA, não exatidão. A via exata (?professor=<id> por
//   professor, ~138 fetches/dia) estoura o throttle. Nome ambíguo → NÃO atribui (melhor faltar
//   que errar). Mesma honestidade do "origem não identificada".
//
// AMPLIAÇÃO FUTURA: salas não entram (sem disponibilidade recorrente no catálogo).
async function captureHistory({ tenantId, binding }) {
  const cfg = binding.config || {};
  const senha = crypto.decrypt(cfg.credential_enc);
  if (!senha) throw new Error('scrape-extranet.captureHistory: credencial vazia/indecifrável');
  const creds = { email: cfg.email, senha, perfil: cfg.perfil, unidade: cfg.unidade };
  const session = await client.getSession(creds);

  // catálogo: professores ativos (id+nome) + capabilities OFERTADAS por professor.
  const teachers = (await withTenant(tenantId, (c) => c.query(
    `SELECT id AS resource_id, name FROM resources.resource WHERE tenant_id=$1 AND type='TEACHER' AND active`, [tenantId]))).rows;
  const capsByResource = new Map();
  for (const row of (await withTenant(tenantId, (c) => c.query(
    `SELECT resource_id, capability_id FROM resources.resource_capability WHERE tenant_id=$1`, [tenantId]))).rows) {
    if (!capsByResource.has(row.resource_id)) capsByResource.set(row.resource_id, []);
    capsByResource.get(row.resource_id).push(row.capability_id);
  }

  // OCUPADO real, DIRETO da grade: próxima ocorrência de cada weekday (gap FORA do lock).
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD BRT
  const occSet = new Set(); // chave: resource|cap|weekday|slot — capacidade consumida
  const stats = { fetched: 0, aulas: 0, resolvidas: 0, ambiguas: 0, semCapability: 0 };
  for (const wd of [1, 2, 3, 4, 5, 6]) {
    const date = valinhos.nextOccurrenceDate(hoje, wd);
    if (stats.fetched > 0) await client.throttleGap();           // gap FORA do lock
    const html = await withExtranetLock(
      () => client.fetchAuthed(`/mod_agenda/api-salas-grade.php?hoje=${date}&professor=`, session, { noGap: true }),
      { timeoutMs: 60000 });
    stats.fetched++;
    for (const aula of valinhos.parseGradeOcupacao(html)) {
      if (!aula.prof || !aula.hora_inicio) continue;
      stats.aulas++;
      const m = valinhos.matchTeacher(aula.prof, teachers);
      if (!m.resource_id) { stats.ambiguas++; continue; }        // não atribui (melhor faltar)
      stats.resolvidas++;
      const caps = capsByResource.get(m.resource_id) || [];
      if (!caps.length) { stats.semCapability++; continue; }
      for (const capId of caps) occSet.add(`${m.resource_id}|${capId}|${wd}|${aula.hora_inicio}`); // capacidade: todas as caps do prof
    }
  }

  // estado anterior (último por slot, via índice changed_at DESC) p/ o DIFF.
  const last = (await withTenant(tenantId, (c) => c.query(
    `SELECT DISTINCT ON (resource_id, capability_id, weekday, slot_time)
            resource_id, capability_id, weekday, to_char(slot_time,'HH24:MI') AS slot_time, occupied
       FROM resources.occupation_history WHERE tenant_id=$1
      ORDER BY resource_id, capability_id, weekday, slot_time, changed_at DESC`, [tenantId]))).rows;
  const lastMap = new Map(last.map((x) => [`${x.resource_id}|${x.capability_id}|${x.weekday}|${x.slot_time}`, x.occupied]));

  // DIFF (só MUDANÇA): novo/virou ocupado → true; estava ocupado e sumiu da grade → false.
  const changes = [];
  for (const key of occSet) {
    if (lastMap.get(key) !== true) { const [r, c, w, s] = key.split('|'); changes.push({ resource_id: r, capability_id: c, weekday: +w, slot_time: s, occupied: true }); }
  }
  for (const [key, occ] of lastMap) {
    if (occ === true && !occSet.has(key)) { const [r, c, w, s] = key.split('|'); changes.push({ resource_id: r, capability_id: c, weekday: +w, slot_time: s, occupied: false }); }
  }

  // insere as mudanças (APPEND-ONLY: só INSERT) sob RLS.
  if (changes.length) {
    await withTenant(tenantId, async (c) => {
      for (const ch of changes) {
        await c.query(
          `INSERT INTO resources.occupation_history (tenant_id, resource_id, capability_id, weekday, slot_time, occupied)
                VALUES ($1, $2, $3, $4, $5::time, $6)`,
          [tenantId, ch.resource_id, ch.capability_id, ch.weekday, ch.slot_time, ch.occupied]);
      }
    });
  }
  return { ...stats, slotsOcupados: occSet.size, mudancasGravadas: changes.length };
}

// suggestRoomCaps — sugestão de capabilities por vocação da sala (pura, sem rede).
// Delega ao de-para específico da fonte (valinhos); a rota acessa via registry (index.js),
// nunca importa valinhos direto.
module.exports = { kind: 'SCRAPE_EXTRANET', produce, captureHistory, suggestRoomCaps: valinhos.suggestRoomCaps };
