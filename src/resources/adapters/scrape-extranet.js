'use strict';

// scrape-extranet.js — ADAPTER de dispatch da fonte SCRAPE_EXTRANET (ADR-026 §2.4).
// Cola: binding (credencial cifrada) → extranet-client (login/sessão/throttle) →
// valinhos (fetch+parse) → ResourceSnapshot genérico. É o que o runner chama p/
// kind='SCRAPE_EXTRANET'. ESPECÍFICO da fonte (camada de adapter) — o core não o conhece.

const crypto = require('../../crypto');
const logger = require('../../logger');
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
// GRÃO: (recurso) × (capability) × weekday × slot_time — para PROFESSOR e para SALA.
//
// ⚠️ SEMÂNTICA P/ O PAINEL — LER COMO CAPACIDADE, NÃO DEMANDA: `occupied=true` significa que o
//   RECURSO está OCUPADO naquele horário (capacidade consumida). O PROFESSOR não dá duas aulas
//   ao mesmo tempo → occupied em TODAS as capabilities dele naquele slot. A SALA (Opção D) está
//   ocupada para TODAS as suas VOCAÇÕES (resource_capability do ROOM) naquele slot. Logo
//   "ocupação de violão" = CAPACIDADE de violão consumida, NÃO "nº de aulas de violão dadas".
//
// ⚠️ STATUS (DP-C, valinhos.statusOcupa): cancelamento NÃO ocupa. Aula 'Cancelada*' aparece na
//   grade futura mas libera o slot → não entra (nem prof nem sala). Status desconhecido =
//   conservador (ocupado) + log. Isto corrige o bug anterior (tudo-que-aparece = ocupado).
//
// ⚠️ APROXIMAÇÃO (decisão consciente): o professor vem por NAME-MATCH (matchTeacher, prefixo
//   ancorado) — métrica de TENDÊNCIA. Nome ambíguo → NÃO atribui o prof, mas a SALA daquela aula
//   AINDA é capturada (a ocupação física da sala independe de identificar o professor).
//
// IO INJETÁVEL: `getGradeHtml(date, idx)` permite testar sem Extranet. Default = fetch real
// (sob pg_advisory_lock, gap FORA do lock). 6 fetches/rodada (1 por weekday); sala sai do MESMO
// HTML — custo de rede ZERO em relação à captura de professor.
async function captureHistory({ tenantId, binding, getGradeHtml }) {
  if (!getGradeHtml) {
    const cfg = binding.config || {};
    const senha = crypto.decrypt(cfg.credential_enc);
    if (!senha) throw new Error('scrape-extranet.captureHistory: credencial vazia/indecifrável');
    const creds = { email: cfg.email, senha, perfil: cfg.perfil, unidade: cfg.unidade };
    const session = await client.getSession(creds);
    getGradeHtml = async (date, idx) => {
      if (idx > 0) await client.throttleGap();                   // gap FORA do lock
      return withExtranetLock(
        () => client.fetchAuthed(`/mod_agenda/api-salas-grade.php?hoje=${date}&professor=`, session, { noGap: true }),
        { timeoutMs: 60000 });
    };
  }

  // catálogo: professores ativos (id+nome), salas ativas (id+external_ref) e o de-para
  // resource→capabilities (serve prof E sala — resource_capability cobre os dois) + ref da cap.
  const teachers = (await withTenant(tenantId, (c) => c.query(
    `SELECT id AS resource_id, name FROM resources.resource WHERE tenant_id=$1 AND type='TEACHER' AND active`, [tenantId]))).rows;
  const rooms = (await withTenant(tenantId, (c) => c.query(
    `SELECT id AS resource_id, external_ref FROM resources.resource WHERE tenant_id=$1 AND type='ROOM' AND active`, [tenantId]))).rows;
  const roomByNum = new Map();        // número da sala (external_ref) → roomResourceId
  for (const r of rooms) { const n = Number(r.external_ref); if (Number.isInteger(n)) roomByNum.set(n, r.resource_id); }
  const capsByResource = new Map();   // resourceId → [capabilityId]  (prof: competências; sala: vocações)
  const capRefById = new Map();       // capabilityId → external_ref  (só p/ a validação informativa)
  for (const row of (await withTenant(tenantId, (c) => c.query(
    `SELECT rc.resource_id, rc.capability_id, cap.external_ref
       FROM resources.resource_capability rc
       JOIN resources.capability cap ON cap.id = rc.capability_id
      WHERE rc.tenant_id=$1`, [tenantId]))).rows) {
    if (!capsByResource.has(row.resource_id)) capsByResource.set(row.resource_id, []);
    capsByResource.get(row.resource_id).push(row.capability_id);
    capRefById.set(row.capability_id, row.external_ref);
  }

  // OCUPADO real, DIRETO da grade: próxima ocorrência de cada weekday.
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD BRT
  const occMap = new Map(); // chave: resource|cap|weekday|slot → slot_end ('HH:MM'|null). Capacidade consumida (prof OU sala).
  const stats = { fetched: 0, aulas: 0, resolvidas: 0, ambiguas: 0, semCapability: 0,
    canceladas: 0, statusDesconhecido: 0, salasResolvidas: 0, salasNaoCasadas: 0, salasSemVocacao: 0, vocacaoInconsistente: 0 };
  let idx = 0;
  for (const wd of [1, 2, 3, 4, 5, 6]) {
    const date = valinhos.nextOccurrenceDate(hoje, wd);
    const html = await getGradeHtml(date, idx); idx++;
    stats.fetched++;
    for (const aula of valinhos.parseGradeOcupacao(html)) {
      if (!aula.hora_inicio) continue;
      stats.aulas++;

      // STATUS (DP-C): cancelada NÃO ocupa; desconhecido = conservador (ocupado) + log p/ revisão.
      if (!valinhos.statusConhecido(aula.status)) {
        stats.statusDesconhecido++;
        logger.warn('capture.status_desconhecido', { tenant_id: tenantId, status: aula.status, sala: aula.sala });
      }
      if (!valinhos.statusOcupa(aula.status)) { stats.canceladas++; continue; } // cancelada → slot livre

      // PROFESSOR — capacidade consumida em TODAS as caps dele (ambíguo: não atribui, mas a sala segue).
      if (aula.prof) {
        const m = valinhos.matchTeacher(aula.prof, teachers);
        if (!m.resource_id) { stats.ambiguas++; } else {
          stats.resolvidas++;
          const caps = capsByResource.get(m.resource_id) || [];
          if (!caps.length) stats.semCapability++;
          for (const capId of caps) occMap.set(`${m.resource_id}|${capId}|${wd}|${aula.hora_inicio}`, aula.hora_fim || null);
        }
      }

      // SALA (Opção D) — UMA linha por VOCAÇÃO da sala. Número "Sala N" → ROOM por external_ref.
      const num = Number((String(aula.sala).match(/\d+/) || [])[0]);
      if (!Number.isInteger(num)) continue;
      const roomId = roomByNum.get(num);
      if (!roomId) { stats.salasNaoCasadas++; logger.warn('capture.sala_nao_casada', { tenant_id: tenantId, sala: aula.sala, num }); continue; }
      const vocacoes = capsByResource.get(roomId) || [];
      if (!vocacoes.length) { stats.salasSemVocacao++; logger.warn('capture.sala_sem_vocacao', { tenant_id: tenantId, sala: aula.sala }); continue; }
      stats.salasResolvidas++;
      // VALIDAÇÃO informativa (não bloqueia): o instrumento da aula está entre as vocações da sala?
      const cursoRef = valinhos.cursoCapRef(aula.curso);
      if (cursoRef && !vocacoes.some((id) => capRefById.get(id) === cursoRef)) {
        stats.vocacaoInconsistente++;
        logger.info('capture.vocacao_inconsistente', { tenant_id: tenantId, sala: aula.sala, curso: aula.curso, curso_cap: cursoRef });
      }
      for (const capId of vocacoes) occMap.set(`${roomId}|${capId}|${wd}|${aula.hora_inicio}`, aula.hora_fim || null);
    }
  }

  // estado anterior (último por slot, via índice changed_at DESC) p/ o DIFF.
  const last = (await withTenant(tenantId, (c) => c.query(
    `SELECT DISTINCT ON (resource_id, capability_id, weekday, slot_time)
            resource_id, capability_id, weekday,
            to_char(slot_time,'HH24:MI') AS slot_time, to_char(slot_end,'HH24:MI') AS slot_end, occupied
       FROM resources.occupation_history WHERE tenant_id=$1
      ORDER BY resource_id, capability_id, weekday, slot_time, changed_at DESC`, [tenantId]))).rows;
  const lastMap = new Map(last.map((x) =>
    [`${x.resource_id}|${x.capability_id}|${x.weekday}|${x.slot_time}`, { occupied: x.occupied, slot_end: x.slot_end }]));

  // DIFF (só MUDANÇA). Compara occupied E slot_end → flip de estado OU mudança de DURAÇÃO da
  // aula re-grava a linha (também faz o legado slot_end=NULL ser regravado com o fim real).
  const changes = [];
  for (const [key, slotEnd] of occMap) {
    const prev = lastMap.get(key);
    if (!prev || prev.occupied !== true || prev.slot_end !== slotEnd) {
      const [r, c, w, s] = key.split('|');
      changes.push({ resource_id: r, capability_id: c, weekday: +w, slot_time: s, slot_end: slotEnd, occupied: true });
    }
  }
  for (const [key, prev] of lastMap) {
    if (prev.occupied === true && !occMap.has(key)) {
      const [r, c, w, s] = key.split('|');
      changes.push({ resource_id: r, capability_id: c, weekday: +w, slot_time: s, slot_end: prev.slot_end, occupied: false });
    }
  }

  // insere as mudanças (APPEND-ONLY: só INSERT) sob RLS. slot_end pode ser NULL (parser sem fim).
  if (changes.length) {
    await withTenant(tenantId, async (c) => {
      for (const ch of changes) {
        await c.query(
          `INSERT INTO resources.occupation_history (tenant_id, resource_id, capability_id, weekday, slot_time, slot_end, occupied)
                VALUES ($1, $2, $3, $4, $5::time, $6::time, $7)`,
          [tenantId, ch.resource_id, ch.capability_id, ch.weekday, ch.slot_time, ch.slot_end, ch.occupied]);
      }
    });
  }
  return { ...stats, slotsOcupados: occMap.size, mudancasGravadas: changes.length };
}

// suggestRoomCaps — sugestão de capabilities por vocação da sala (pura, sem rede).
// Delega ao de-para específico da fonte (valinhos); a rota acessa via registry (index.js),
// nunca importa valinhos direto.
module.exports = { kind: 'SCRAPE_EXTRANET', produce, captureHistory, suggestRoomCaps: valinhos.suggestRoomCaps };
