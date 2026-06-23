'use strict';

// ============================================================================
// Surface A (ADR-022) — CONSUMIDOR do evento canônico de progressão.
// AGNÓSTICO DE FONTE: não sabe se veio do scraper da Extranet, de um BI ou do
// Regente — só do evento. As fontes são adapters (ADR §8.1).
//
// `processarEvento(c, { tenantId, evento })` roda DENTRO de um client withTenant
// (RLS já no escopo), mas o matcher TAMBÉM filtra por tenant_id explicitamente
// (ADR §8.3: não delega só à RLS). Função pura do ponto de vista de I/O — recebe
// o client, então é testável com um client mockado, sem banco.
//
// evento = {
//   tipo: 'experimental_realizada' | 'matricula_confirmada',
//   source_adapter, source_record_id, situacao,   // idempotência (ADR §9.4)
//   student_name?, telefone?,                       // chaves de match (agnóstico de chave)
// }
// ============================================================================

const TIPOS = ['experimental_realizada', 'matricula_confirmada'];

// Rank das etapas — avanço é SÓ "para frente" (não regride, não dupla-progride).
const RANK = { NEW: 0, REVIEW_QUEUE: 0, NOT_LEAD: 0, QUALIFYING: 1, QUALIFIED: 2, EXPERIMENTAL_AGENDADA: 3, CONVERTED: 4 };
const DEST_RANK = { experimental: 3, convertido: 4 };

function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function digits(s) { return String(s || '').replace(/\D/g, ''); }

// Matcher ESCOPADO POR tenant (explícito) e AGNÓSTICO DE CHAVE: telefone exato
// quando o evento traz → senão nome do aluno + janela temporal → senão sem-match.
async function _match(c, tenantId, { telefone, studentName }) {
  const rows = (await c.query(
    `SELECT id, name, student_name, phone, status, auto_progress_locked, created_at
       FROM leads WHERE tenant_id = $1`, [tenantId])).rows;

  const tel = digits(telefone).slice(-8);
  if (tel.length >= 8) {
    const hits = rows.filter((r) => digits(r.phone).slice(-8) === tel);
    if (hits.length === 1) return { lead: hits[0], how: 'phone' };
    if (hits.length > 1) return { ambiguous: true, how: 'phone' };
  }

  const nome = normName(studentName);
  if (nome.length >= 3) {
    const cutoff = Date.now() - 120 * 864e5; // janela de 120 dias
    const hits = rows.filter((r) =>
      (normName(r.student_name) === nome || normName(r.name) === nome) &&
      new Date(r.created_at).getTime() > cutoff);
    if (hits.length === 1) return { lead: hits[0], how: 'name' };
    if (hits.length > 1) return { ambiguous: true, how: 'name' };
  }

  return { none: true };
}

// Move o card (avanço só pra frente). Carimba proveniência+ator = sistema.
async function _mover(c, tenantId, leadId, destCol, adapter) {
  const status = destCol === 'convertido' ? 'CONVERTED' : 'EXPERIMENTAL_AGENDADA';
  const setDesfecho = destCol === 'convertido' ? ", desfecho = 'matriculado', desfecho_em = now()" : '';
  await c.query(
    `UPDATE leads SET status = $2${setDesfecho},
                      progressao_source = 'system', progressao_adapter = $3, updated_at = now()
      WHERE id = $1`, [leadId, status, adapter]);
  await c.query(
    `INSERT INTO lead_eventos (tenant_id, lead_id, tipo, autor, conteudo, etapa_key)
     VALUES ($1, $2, 'mudanca_etapa', 'system', $3, $4)`,
    [tenantId, leadId, `avançou via check ${adapter}`, destCol]);
}

async function _nota(c, tenantId, leadId, texto) {
  await c.query(
    `INSERT INTO lead_eventos (tenant_id, lead_id, tipo, autor, conteudo)
     VALUES ($1, $2, 'nota', 'system', $3)`, [tenantId, leadId, texto]);
}

async function _criarWalkIn(c, tenantId, { studentName, telefone, tipo }) {
  const status = tipo === 'matricula_confirmada' ? 'CONVERTED' : 'EXPERIMENTAL_AGENDADA';
  const desfecho = tipo === 'matricula_confirmada' ? 'matriculado' : null;
  const phone = digits(telefone) || null;
  // Dedupe por (tenant, phone) quando há telefone; sem telefone, insere direto.
  const r = await c.query(
    `INSERT INTO leads (tenant_id, name, student_name, phone, status, desfecho, desfecho_em, origem, progressao_source, progressao_adapter)
     VALUES ($1, $2, $2, $3, $4, $5, ${desfecho ? 'now()' : 'NULL'}, 'walk_in', 'system', 'extranet')
     ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL
       DO UPDATE SET status = EXCLUDED.status, updated_at = now()
     RETURNING id`,
    [tenantId, studentName || null, phone, status, desfecho]);
  return r.rows[0] ? r.rows[0].id : null;
}

async function _registrarLabel(c, tenantId, leadId, tipo, aiRoutedTo) {
  await c.query(
    `INSERT INTO lead_eval_label (tenant_id, lead_id, label, source, trigger, ai_routed_to, by)
     VALUES ($1, $2, 'lead', 'derived_funnel', $3, $4, 'system')`,
    [tenantId, leadId, tipo, aiRoutedTo]);
}

async function _registrarLedger(c, tenantId, evento, leadId, resultado) {
  await c.query(
    `INSERT INTO progressao_event_ledger
       (tenant_id, source_adapter, source_record_id, situacao, tipo, lead_id, resultado)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, evento.source_adapter, evento.source_record_id, evento.situacao, evento.tipo, leadId, resultado]);
}

async function processarEvento(c, { tenantId, evento }) {
  const tipo = evento && evento.tipo;
  if (!TIPOS.includes(tipo)) return { status: 'invalid', reason: 'tipo' };
  const sourceAdapter = String(evento.source_adapter || '').trim();
  const sourceRecordId = String(evento.source_record_id || '').trim();
  const situacao = String(evento.situacao || '').trim();
  if (!sourceAdapter || !sourceRecordId || !situacao) return { status: 'invalid', reason: 'chave' };
  const ev = { ...evento, source_adapter: sourceAdapter, source_record_id: sourceRecordId, situacao };

  // Idempotência (ADR §9.4): mesmo (tenant, adapter, registro, situação) → no-op.
  const dup = await c.query(
    `SELECT lead_id, resultado FROM progressao_event_ledger
      WHERE tenant_id = $1 AND source_adapter = $2 AND source_record_id = $3 AND situacao = $4`,
    [tenantId, sourceAdapter, sourceRecordId, situacao]);
  if (dup.rowCount) {
    return { status: 'duplicate', resultado: dup.rows[0].resultado, lead_id: dup.rows[0].lead_id };
  }

  const m = await _match(c, tenantId, { telefone: ev.telefone, studentName: ev.student_name });

  let leadId = null;
  let resultado;
  let alerta = false;

  if (m.ambiguous) {
    // Match ambíguo → NÃO progride. Registra para a fila Revisar (painel S6 lê do ledger).
    resultado = 'review';
  } else if (m.lead) {
    leadId = m.lead.id;
    const aiRoutedTo = m.lead.status || null;   // snapshot do que a IA decidira (recall não-circular)
    const curRank = RANK[m.lead.status] ?? 0;

    if (tipo === 'experimental_realizada') {
      if (m.lead.auto_progress_locked) {
        // Trava manual (ADR §9.3): humano moveu → experimental NÃO fura a trava.
        await _nota(c, tenantId, leadId, '[sistema] experimental detectada, mas card travado por ação humana — não movido.');
        resultado = 'locked_skip';
      } else if (curRank < DEST_RANK.experimental) {
        await _registrarLabel(c, tenantId, leadId, tipo, aiRoutedTo);
        await _mover(c, tenantId, leadId, 'experimental', sourceAdapter);
        resultado = 'advanced';
      } else {
        resultado = 'noop_ahead'; // já está em/à frente de experimental
      }
    } else { // matricula_confirmada — FURA a trava manual sempre (ADR §9.3), com alerta.
      if (curRank < DEST_RANK.convertido) {
        await _registrarLabel(c, tenantId, leadId, tipo, aiRoutedTo);
        await _mover(c, tenantId, leadId, 'convertido', sourceAdapter);
        await _nota(c, tenantId, leadId,
          `[ALERTA] matrícula confirmada via ${sourceAdapter} — lead concluído automaticamente${m.lead.auto_progress_locked ? ' (furou a trava manual)' : ''}.`);
        resultado = 'concluded';
        alerta = true;
      } else {
        resultado = 'noop_ahead';
      }
    }
  } else {
    // Sem match → lead de rua (walk-in) no estágio que o evento implica.
    leadId = await _criarWalkIn(c, tenantId, { studentName: ev.student_name, telefone: ev.telefone, tipo });
    if (leadId) await _registrarLabel(c, tenantId, leadId, tipo, 'walk_in');
    if (tipo === 'matricula_confirmada') {
      if (leadId) await _nota(c, tenantId, leadId, `[ALERTA] matrícula confirmada via ${sourceAdapter} — lead de rua criado já concluído.`);
      resultado = 'walk_in_concluded';
      alerta = true;
    } else {
      resultado = 'walk_in';
    }
  }

  await _registrarLedger(c, tenantId, ev, leadId, resultado);
  return { status: 'ok', resultado, lead_id: leadId, match: m.how || (m.ambiguous ? 'ambiguous' : 'none'), alerta };
}

module.exports = { processarEvento, normName, digits, TIPOS };
