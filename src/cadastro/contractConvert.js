'use strict';
//
// contractConvert.js — CONVERTIDO POR ORIGEM + ESTADO "CLIENTE" (079). Duas réguas em sequência:
//
// 1) VÍNCULO (quem é pagante) — a PESSOA do lead está ligada a um contrato VIGENTE (service_account)
//    via account_member, como beneficiario (é o aluno) OU pagador (é o responsável). Pai que matricula
//    filho = vínculo do lead do pai. É o VÍNCULO do cadastro (ADR-037), não fuzzy de nome. A ponte
//    lead→person é o telefone (contact_point), pois leads não tem person_id. Sem vínculo → não toca.
//
// 2) ORIGEM (o que o vínculo significa) — só é CONVERSÃO quem NASCEU no funil do Regente e DEPOIS
//    virou contrato:
//      marco    = PRIMEIRA MENSAGEM da conversa (fallback: leads.created_at se não há conversa).
//                 created_at NÃO serve de marco primário: a ingestão em lote de jun/2026 o carimbou
//                 até 13 dias DEPOIS da 1ª mensagem real.
//      matricula = MENOR ini_vigencia entre TODOS os contratos da pessoa (inclusive expirados) — a
//                 matrícula ORIGINAL. Ler a do contrato vigente seria confundir RENOVAÇÃO com
//                 matrícula nova (Vanessa Garcia: 5 contratos de Guitarra desde 2024).
//      matricula >= marco - JANELA → 'convertido' (data = a matrícula real)   → entra na taxa
//      matricula <  marco - JANELA → 'cliente'    (pré-existente)             → fora da fila e da taxa
//    JANELA (default 7d, por-tenant) = tolerância para contrato assinado POUCO ANTES da 1ª mensagem
//    (assinatura ≠ início de vigência). NÃO é teto para a frente: conversa em junho que fecha com
//    vigência em agosto (44–51 dias) É conversão — o Regente acompanhou o fechamento.
//
// GUARDAS (nesta ordem, sempre):
//   • latch HUMANO (review_result=confirmed_not_lead com review_by = pessoa real, ≠ 'SERVICE') → não toca.
//     O NOT_LEAD auto do gate/SERVICE NÃO bloqueia (ser conhecido é o que faz do lead um cliente).
//   • desfecho='matriculado' posto por humano NUNCA vira 'cliente' (decisão humana é terminal).
//   • em modo 'auto', 'cliente' só é aplicado sozinho em lead JÁ fora do funil; lead VIVO (em conversa,
//     sem desfecho) vai para a FILA — a máquina não tira sozinha da mesa um lead vivo (molde e057bee).
//
// ANTI-LEAKAGE: lê só tabelas NORMALIZADAS do cadastro canônico (core), não o adapter da Extranet.
// Aplicação com log/evento no formato da 078 (stage_autoapply_log) → REVERTÍVEL card a card no Monitor.
//
const { matchKeys } = require('../telefoneBR');
const stages = require('../stages');

const JANELA_PADRAO_DIAS = 7;

const _phoneDigits = (s) => String(s || '').replace(/\D/g, '');
const iso = (d) => (d && (d.toISOString ? d.toISOString().slice(0, 10) : String(d).slice(0, 10))) || null;
// Data ISO deslocada em dias (só aritmética de calendário — sem timezone; as duas pontas são datas).
const shiftDays = (isoDate, days) => {
  if (!isoDate) return null;
  const t = new Date(`${isoDate}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

const _terminalConvertido = (l) => ['CONVERTED', 'WON'].includes(String(l.status || '').toUpperCase());
// LATCH HUMANO — RESPEITAR: decisão de uma PESSOA (review_by = papel real). O NOT_LEAD auto do gate
// (review_by='SERVICE' ou nulo) NÃO é latch humano e não bloqueia a régua.
const _humanLatched = (l) => l.review_result === 'confirmed_not_lead' && !!l.review_by && l.review_by !== 'SERVICE';
// Lead VIVO no funil: está numa etapa de trabalho e ainda não tem desfecho. Guarda do 'cliente' auto.
const _vivoNoFunil = (l) => !l.desfecho
  && !['NOT_LEAD', 'REVIEW_QUEUE', 'PENDING_CLASSIFICATION'].includes(String(l.status || '').toUpperCase());

// Config por-tenant (mode + janela). Sem linha → default inerte. Sem as colunas (migration 079 ainda
// não aplicada) → mesmo default, sem explodir: degrada elegante como o loadStages.
async function loadConfig(c, tenantId) {
  let r = {};
  try {
    r = (await c.query(
      'SELECT contract_convert_mode, contract_convert_janela_dias FROM lead_manager.tenant_lead_config WHERE tenant_id=$1',
      [tenantId])).rows[0] || {};
  } catch { r = {}; }
  return {
    mode: r.contract_convert_mode || 'off',
    janelaDias: Number.isInteger(r.contract_convert_janela_dias) ? r.contract_convert_janela_dias : JANELA_PADRAO_DIAS,
  };
}

// ÍNDICE do vínculo, por telefone. Duas camadas, propositalmente distintas:
//   vigentes  → é pagante HOJE (decide se a régua age) — filtra fim_vigencia/fonte_ausente_em.
//   historico → TODOS os contratos da pessoa (inclusive expirados) — de onde sai a matrícula ORIGINAL.
//               É o que impede ler renovação como matrícula nova.
// marcos    → 1ª mensagem por telefone (conversas do tenant), o marco de "virou lead no Regente".
async function buildContractIndex(c, { tenantId, today } = {}) {
  const hoje = today || new Date().toISOString().slice(0, 10);
  const vig = (await c.query(
    `SELECT am.account_id, sa.ini_vigencia, am.bond, cp.value_raw phone,
            (SELECT string_agg(DISTINCT p2.display_name, ' / ') FROM lead_manager.account_member am2
               JOIN lead_manager.person p2 ON p2.id = am2.person_id
              WHERE am2.account_id = am.account_id AND am2.bond = 'beneficiario') aluno
       FROM lead_manager.account_member am
       JOIN lead_manager.service_account sa ON sa.id = am.account_id
            AND sa.fonte_ausente_em IS NULL AND sa.fim_vigencia >= $1
       JOIN lead_manager.contact_point cp ON cp.person_id = am.person_id AND cp.kind = 'phone'
      WHERE am.tenant_id = $2`, [hoje, tenantId])).rows;
  const hist = (await c.query(
    `SELECT sa.ini_vigencia, cp.value_raw phone
       FROM lead_manager.account_member am
       JOIN lead_manager.service_account sa ON sa.id = am.account_id
       JOIN lead_manager.contact_point cp ON cp.person_id = am.person_id AND cp.kind = 'phone'
      WHERE am.tenant_id = $1 AND sa.ini_vigencia IS NOT NULL`, [tenantId])).rows;
  const marcos = (await c.query(
    `SELECT regexp_replace(cv.external_id, '[^0-9]', '', 'g') AS dg, min(m.received_at) AS msg1
       FROM lead_manager.conversations cv
       JOIN lead_manager.messages m ON m.conversation_id = cv.id
      WHERE cv.tenant_id = $1 GROUP BY 1`, [tenantId])).rows;

  const phoneToRows = new Map();
  for (const r of vig) for (const k of matchKeys(r.phone)) {
    if (!phoneToRows.has(k)) phoneToRows.set(k, []);
    phoneToRows.get(k).push(r);
  }
  const phoneToInis = new Map();   // telefone → [ini_vigencia ISO] de TODOS os contratos
  for (const r of hist) for (const k of matchKeys(r.phone)) {
    if (!phoneToInis.has(k)) phoneToInis.set(k, []);
    phoneToInis.get(k).push(iso(r.ini_vigencia));
  }
  const phoneToMsg1 = new Map();   // telefone → 1ª mensagem (a MAIS ANTIGA entre conversas que casam)
  for (const r of marcos) for (const k of matchKeys(r.dg)) {
    const d = iso(r.msg1);
    if (!d) continue;
    if (!phoneToMsg1.has(k) || d < phoneToMsg1.get(k)) phoneToMsg1.set(k, d);
  }
  return { phoneToRows, phoneToInis, phoneToMsg1 };
}

// Marco do lead: 1ª mensagem da conversa; sem conversa, created_at (fallback honesto).
function marcoDoLead(lead, index) {
  for (const k of matchKeys(lead.phone)) {
    const d = index.phoneToMsg1.get(k);
    if (d) return { marco: d, marcoFonte: 'primeira_mensagem' };
  }
  return { marco: iso(lead.created_at), marcoFonte: 'created_at' };
}

// DECISÃO por lead: vínculo + origem. Devolve { decisao: null } quando não há vínculo vigente.
//   { decisao:'convertido'|'cliente', marco, marcoFonte, matriculaPrimeira, matricula, papel,
//     accountId, aluno, nContratos, janelaDias }
function decidir(lead, index, { janelaDias = JANELA_PADRAO_DIAS } = {}) {
  if (_phoneDigits(lead.phone) === '') return { decisao: null, motivo: 'sem_telefone' };
  const seen = new Set(); const accounts = [];
  for (const k of matchKeys(lead.phone)) for (const r of (index.phoneToRows.get(k) || [])) {
    const id = r.account_id + '|' + r.bond;
    if (!seen.has(id)) { seen.add(id); accounts.push(r); }
  }
  if (!accounts.length) return { decisao: null, motivo: 'sem_vinculo' };

  const papel = accounts.some((a) => a.bond === 'beneficiario') ? 'aluno' : 'responsavel';
  const { marco, marcoFonte } = marcoDoLead(lead, index);
  // Histórico COMPLETO da pessoa (não só o vigente) → matrícula original.
  const inisHist = [...new Set([].concat(...matchKeys(lead.phone).map((k) => index.phoneToInis.get(k) || [])))]
    .filter(Boolean).sort();
  const inisVig = accounts.map((a) => iso(a.ini_vigencia)).filter(Boolean).sort();
  const matriculaPrimeira = inisHist[0] || inisVig[0] || null;
  const limite = marco ? shiftDays(marco, -janelaDias) : null;
  // Nasceu no funil: NENHUMA matrícula é anterior ao marco (com a folga da janela).
  const nasceuNoFunil = !!(matriculaPrimeira && limite && matriculaPrimeira >= limite);

  const accId = accounts.find((a) => iso(a.ini_vigencia) === (nasceuNoFunil ? matriculaPrimeira : inisVig[inisVig.length - 1]))?.account_id
    || accounts[0].account_id;
  return {
    decisao: nasceuNoFunil ? 'convertido' : 'cliente',
    marco, marcoFonte, matriculaPrimeira,
    matricula: matriculaPrimeira,           // data que vira desfecho_em nos dois casos
    papel, accountId: accId, aluno: accounts[0].aluno,
    nContratos: new Set(accounts.map((a) => a.account_id)).size,
    nContratosHist: inisHist.length, janelaDias,
  };
}

// Aplicação genérica (convertido | cliente) — mesmo log/evento, revertível no Monitor da 078.
// 'convertido': status CONVERTED + desfecho matriculado. 'cliente': status NOT_LEAD + desfecho cliente.
async function _aplicar(c, { tenantId, leadId, destino, data, reasoning, externalMessageId }) {
  const l = (await c.query(
    'SELECT status, desfecho, desfecho_em, review_result, review_by FROM leads WHERE id=$1', [leadId])).rows[0];
  if (!l) return { notFound: true };
  if (_humanLatched(l)) return { skip: 'human_latched' };
  const origem = stages.stageKey(l.status, l.desfecho);
  if (destino === 'convertido') {
    if (_terminalConvertido(l) && l.desfecho === 'matriculado') return { skip: 'already' };
  } else {
    // GUARDA: matrícula/conversão registrada NUNCA é rebaixada a 'cliente'.
    if (l.desfecho === 'matriculado' || _terminalConvertido(l)) return { skip: 'matriculado' };
    if (l.desfecho === stages.CLIENTE_DESFECHO) return { skip: 'already' };
  }
  const [status, desfecho, conteudo] = destino === 'convertido'
    ? ['CONVERTED', 'matriculado', 'movido para convertido — nasceu no funil e a matrícula veio depois (vínculo do contrato)']
    : ['NOT_LEAD', stages.CLIENTE_DESFECHO, 'marcado como cliente — contrato ANTERIOR ao primeiro contato (pré-existente, não é conversão)'];
  await c.query(
    // desfecho_em: preserva o que um humano já registrou; senão, a data da matrícula real.
    'UPDATE leads SET status=$2, desfecho=$3, desfecho_em=COALESCE(desfecho_em, $4::timestamptz, now()), updated_at=now() WHERE id=$1',
    [leadId, status, desfecho, data || null]);
  const evento = (await c.query(
    `INSERT INTO lead_eventos (tenant_id, lead_id, tipo, autor, conteudo, etapa_key)
     VALUES ($1,$2,'mudanca_etapa','contrato_auto',$3,$4) RETURNING id`, [tenantId, leadId, conteudo, destino])).rows[0];
  await c.query('UPDATE leads SET suggested_stage=NULL, stage_reasoning=NULL, stage_suggested_at=NULL WHERE id=$1', [leadId]);
  const log = (await c.query(
    `INSERT INTO stage_autoapply_log
       (tenant_id, lead_id, from_stage, to_stage, reasoning, source, external_message_id,
        prior_status, prior_desfecho, prior_desfecho_em, evento_id)
     VALUES ($1,$2,$3,$4,$5,'contract_match',$6,$7,$8,$9,$10) RETURNING id`,
    [tenantId, leadId, origem, destino, reasoning || conteudo, externalMessageId || null,
     l.status, l.desfecho, l.desfecho_em, evento.id])).rows[0];
  return { applied: true, destino, logId: log.id, from: origem, evento_id: evento.id };
}

const applyConvertidoContract = (c, { tenantId, leadId, ini, reasoning, externalMessageId }) =>
  _aplicar(c, { tenantId, leadId, destino: 'convertido', data: ini, reasoning, externalMessageId });
const applyClienteContract = (c, { tenantId, leadId, matricula, reasoning, externalMessageId }) =>
  _aplicar(c, { tenantId, leadId, destino: 'cliente', data: matricula, reasoning, externalMessageId });

async function enqueuePending(c, { tenantId, leadId, accountId, decisao, marco, matriculaPrimeira, ini, phone, aluno, reason }) {
  const r = await c.query(
    `INSERT INTO lead_manager.contract_match_pending
       (tenant_id, lead_id, account_id, decisao, marco_lead, matricula_primeira,
        contract_ini_vigencia, matched_phone, contract_names, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id, lead_id, account_id) DO NOTHING RETURNING id`,
    [tenantId, leadId, accountId, decisao || 'convertido', marco || null, matriculaPrimeira || null,
     ini || null, phone || null, aluno || null, reason]);
  return r.rows[0]?.id || null;
}

// Leads elegíveis. Fora: latch HUMANO; quem já é 'cliente' (a marca no LEAD é o que impede o
// re-enfileiramento a cada renovação); já convertido; e 'matriculado' decidido por humano DENTRO do
// funil (M.Neto/Eduardo Parma — conversão manual que a régua não pode rebaixar). Fica DENTRO o
// 'matriculado' com status NOT_LEAD/REVIEW_QUEUE: é matrícula real fora do universo do BI (Massa),
// que a régua de origem normaliza para CONVERTED.
async function eligibleLeads(c, { tenantId, leadIds } = {}) {
  const base = "tenant_id=$1 AND coalesce(phone,'')<>''"
    + " AND coalesce(status,'') NOT IN ('CONVERTED','WON')"
    + " AND coalesce(desfecho,'') <> 'cliente'"
    + " AND NOT (coalesce(desfecho,'')='matriculado' AND coalesce(status,'') NOT IN ('NOT_LEAD','REVIEW_QUEUE'))"
    + " AND NOT (review_result='confirmed_not_lead' AND review_by IS NOT NULL AND review_by <> 'SERVICE')";
  const where = leadIds && leadIds.length ? `${base} AND id = ANY($2::uuid[])` : base;
  const params = leadIds && leadIds.length ? [tenantId, leadIds] : [tenantId];
  return (await c.query(
    `SELECT id, name, phone, status, desfecho, created_at FROM lead_manager.leads WHERE ${where}`, params)).rows;
}

// BACKFILL em modo LISTA (read-only, NÃO move nada) — as duas datas lado a lado, p/ revisão humana.
// { converte:[...], clientes:[...] }, cada item com marco_lead vs matricula_primeira e o gap em dias.
async function buildBackfillList(c, { tenantId, janelaDias } = {}) {
  const cfg = await loadConfig(c, tenantId);
  const janela = Number.isInteger(janelaDias) ? janelaDias : cfg.janelaDias;
  const index = await buildContractIndex(c, { tenantId });
  const leads = await eligibleLeads(c, { tenantId });
  const out = { converte: [], clientes: [], janela_dias: janela };
  for (const l of leads) {
    const d = decidir(l, index, { janelaDias: janela });
    if (!d.decisao) continue;
    const gap = d.marco && d.matriculaPrimeira
      ? Math.round((new Date(`${d.matriculaPrimeira}T00:00:00Z`) - new Date(`${d.marco}T00:00:00Z`)) / 86400000) : null;
    const item = {
      lead_id: l.id, lead_name: l.name, status: l.status, papel: d.papel, aluno: d.aluno,
      marco_lead: d.marco, marco_fonte: d.marcoFonte, matricula_primeira: d.matriculaPrimeira,
      gap_dias: gap, n_contratos: d.nContratos, n_contratos_hist: d.nContratosHist,
    };
    (d.decisao === 'convertido' ? out.converte : out.clientes).push(item);
  }
  return out;
}

// mode: 'off'|'suggestion'|'auto'. Ver o cabeçalho para as guardas do 'auto'.
async function runContractConvert(c, { tenantId, mode, janelaDias, leadIds } = {}) {
  const stats = { scanned: 0, convertido: 0, cliente: 0, queued: 0, skipped: 0, none: 0 };
  const cfg = await loadConfig(c, tenantId);
  const m = mode || cfg.mode;
  const janela = Number.isInteger(janelaDias) ? janelaDias : cfg.janelaDias;
  if (!m || m === 'off') { stats.skipped = -1; return stats; }
  const index = await buildContractIndex(c, { tenantId });
  const leads = await eligibleLeads(c, { tenantId, leadIds });
  for (const lead of leads) {
    stats.scanned++;
    const d = decidir(lead, index, { janelaDias: janela });
    if (!d.decisao) { stats.none++; continue; }
    // 'cliente' só sai sozinho se o lead JÁ está fora do funil; lead vivo vai para a fila.
    const autoOk = m === 'auto' && (d.decisao === 'convertido' || !_vivoNoFunil(lead));
    if (autoOk) {
      const a = d.decisao === 'convertido'
        ? await applyConvertidoContract(c, { tenantId, leadId: lead.id, ini: d.matricula })
        : await applyClienteContract(c, { tenantId, leadId: lead.id, matricula: d.matricula });
      if (a.applied) stats[d.decisao]++; else stats.skipped++;
    } else if (await enqueuePending(c, {
      tenantId, leadId: lead.id, accountId: d.accountId, decisao: d.decisao, marco: d.marco,
      matriculaPrimeira: d.matriculaPrimeira, ini: d.matricula, phone: lead.phone, aluno: d.aluno, reason: d.papel,
    })) stats.queued++;
  }
  return stats;
}

async function confirmPending(c, { tenantId, pendingId, actor }) {
  const p = (await c.query(
    `SELECT lead_id, decisao, contract_ini_vigencia, status
       FROM lead_manager.contract_match_pending WHERE id=$1`, [pendingId])).rows[0];
  if (!p) return { erro: 'não encontrado', code: 404 };
  if (p.status !== 'pending') return { erro: 'já resolvido', code: 409 };
  const destino = p.decisao === 'cliente' ? 'cliente' : 'convertido';
  const a = await _aplicar(c, {
    tenantId, leadId: p.lead_id, destino, data: iso(p.contract_ini_vigencia),
    reasoning: destino === 'convertido'
      ? 'matrícula confirmada pela recepção (nasceu no funil + vínculo do contrato)'
      : 'cliente pré-existente confirmado pela recepção (contrato anterior ao primeiro contato)',
  });
  if (a.skip || !a.applied) {
    await c.query(
      "UPDATE lead_manager.contract_match_pending SET status='dismissed', resolved_at=now(), resolved_by=$2 WHERE id=$1",
      [pendingId, actor || 'recepcao']);
    return { erro: `não aplicável (${a.skip || 'estado mudou'})`, code: 409 };
  }
  await c.query(
    "UPDATE lead_manager.contract_match_pending SET status='confirmed', resolved_at=now(), resolved_by=$2, autoapply_log_id=$3 WHERE id=$1",
    [pendingId, actor || 'recepcao', a.logId]);
  return { ok: true, lead_id: p.lead_id, decisao: destino, autoapply_log_id: a.logId };
}

async function dismissPending(c, { tenantId, pendingId, actor }) {
  const r = await c.query(
    "UPDATE lead_manager.contract_match_pending SET status='dismissed', resolved_at=now(), resolved_by=$2 WHERE id=$1 AND status='pending' RETURNING lead_id",
    [pendingId, actor || 'recepcao']);
  if (!r.rows[0]) return { erro: 'não encontrado ou já resolvido', code: 409 };
  return { ok: true, lead_id: r.rows[0].lead_id };
}

module.exports = {
  JANELA_PADRAO_DIAS, loadConfig, buildContractIndex, marcoDoLead, decidir,
  applyConvertidoContract, applyClienteContract, enqueuePending,
  eligibleLeads, buildBackfillList, runContractConvert, confirmPending, dismissPending,
};
