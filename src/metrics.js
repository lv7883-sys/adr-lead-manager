'use strict';
//
// metrics.js — agregações do dashboard de gestão (G). Uma query "fatos por lead"
// + agregados de aprovação/mês-a-mês; o grosso do cálculo (SLA, percentis,
// temperatura, heatmap) é feito em JS aqui, pra ficar testável.
//
const { withTenant } = require('./db');

const PERIODS = { '7d': 7, '30d': 30, '90d': 90 };

// --- helpers ---------------------------------------------------------------
function percentile(sortedAsc, q) {
  const n = sortedAsc.length;
  if (!n) return null;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
  return sortedAsc[idx];
}
function round(v, d = 1) {
  if (v == null || Number.isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
// Hora/dia-da-semana em America/Sao_Paulo (UTC-3 fixo — Brasil sem horário de verão
// desde 2019). dow: 0=Dom .. 6=Sáb.
function spHourDow(ts) {
  const t = new Date(ts).getTime() - 3 * 3600 * 1000;
  const x = new Date(t);
  return { hour: x.getUTCHours(), dow: x.getUTCDay() };
}
function temperatura(l) {
  if (l.temperatura_manual === 'quente' || l.temperatura_manual === 'morno' || l.temperatura_manual === 'frio') return l.temperatura_manual;
  const intent = String(l.intent || '').toUpperCase();
  const status = String(l.status || '').toUpperCase();
  if (l.qualif === true || intent === 'SCHEDULE_INTEREST') return 'quente';
  const ultimo = l.last_in || l.last_out || l.created_at;
  const horas = ultimo ? (Date.now() - new Date(ultimo).getTime()) / 36e5 : null;
  if (status === 'COLD' || (horas != null && horas > 24)) return 'frio';
  return 'morno';
}
const NAO_MATRICULA = {
  nao_matriculado_preco: 'Preço',
  nao_matriculado_horario: 'Horário',
  nao_matriculado_concorrente: 'Concorrente',
  nao_matriculado_desistiu: 'Desistiu',
  nao_compareceu_aula: 'Não compareceu',
  outro: 'Outro',
};

// --- principal -------------------------------------------------------------
async function computeMetrics(tenantId, { period = '30d', channel = null } = {}) {
  const days = PERIODS[period] || 30;

  return withTenant(tenantId, async (c) => {
    // 1) FATOS POR LEAD (criados no período).
    const leads = (
      await c.query(
        `WITH base AS (
           SELECT l.id, l.name, l.status, l.intent, l.created_at, l.desfecho, l.desfecho_em, l.temperatura_manual,
                  regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g') AS ident,
                  q.instrument, COALESCE(q.qualification_complete, false) AS qualif
             FROM leads l
             LEFT JOIN lead_qualifications q ON q.lead_id = l.id
            WHERE l.created_at >= now() - ($2 || ' days')::interval
              AND l.status NOT IN ('NOT_LEAD', 'REVIEW_QUEUE')   -- só leads reais (Bloco 2)
         ),
         inb AS (
           SELECT regexp_replace(cv.external_id, '[^0-9]', '', 'g') AS ident,
                  min(m.received_at) AS first_in, max(m.received_at) AS last_in
             FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
            WHERE cv.tenant_id = $1 AND m.role = 'USER'
            GROUP BY 1
         ),
         outb AS (
           SELECT regexp_replace(s.external_id, '[^0-9]', '', 'g') AS ident,
                  min(s.received_at) AS first_out, max(s.received_at) AS last_out,
                  (array_agg(s.sender ORDER BY s.received_at))[1] AS first_sender
             FROM staff_outbound_samples s
            WHERE s.tenant_id = $1
              AND coalesce(s.raw->'data'->'key'->>'remoteJid', '') NOT LIKE '%@g.us'
            GROUP BY 1
         ),
         chan AS (
           SELECT regexp_replace(external_id, '[^0-9]', '', 'g') AS ident,
                  (array_agg(channel ORDER BY updated_at DESC))[1] AS channel
             FROM conversations WHERE tenant_id = $1 GROUP BY 1
         )
         SELECT b.id, b.name, b.status, b.intent, b.created_at, b.desfecho, b.desfecho_em, b.temperatura_manual,
                b.instrument, b.qualif,
                i.first_in, i.last_in, o.first_out, o.last_out, o.first_sender,
                c.channel
           FROM base b
           LEFT JOIN inb  i ON i.ident = b.ident AND b.ident <> ''
           LEFT JOIN outb o ON o.ident = b.ident AND b.ident <> ''
           LEFT JOIN chan c ON c.ident = b.ident AND b.ident <> ''`,
        [tenantId, days]
      )
    ).rows;

    // 2) APROVAÇÕES: breakdown no período + backlog atual + tempo rascunho->decisão.
    const appr = (
      await c.query(
        `SELECT
           count(*) FILTER (WHERE status = 'PENDING') AS backlog,
           count(*) FILTER (WHERE status = 'APPROVED' AND created_at >= now() - ($2||' days')::interval) AS aprovados,
           count(*) FILTER (WHERE status = 'EDITED'   AND created_at >= now() - ($2||' days')::interval) AS editados,
           count(*) FILTER (WHERE status = 'REJECTED' AND created_at >= now() - ($2||' days')::interval) AS rejeitados,
           avg(EXTRACT(EPOCH FROM (decided_at - created_at)))
             FILTER (WHERE decided_at IS NOT NULL AND created_at >= now() - ($2||' days')::interval) AS seg_ate_decisao
         FROM pending_approvals WHERE tenant_id = $1`,
        [tenantId, days]
      )
    ).rows[0];

    // 3) MÊS A MÊS (últimos 6 meses): volume de leads + taxa de aceitação da IA.
    const porMes = (
      await c.query(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS mes, count(*) AS n
           FROM leads WHERE created_at >= now() - interval '6 months'
             AND status NOT IN ('NOT_LEAD', 'REVIEW_QUEUE')
          GROUP BY 1 ORDER BY 1`,
        []
      )
    ).rows;
    const aceitMes = (
      await c.query(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS mes,
                count(*) FILTER (WHERE status IN ('APPROVED','EDITED')) AS aceitos,
                count(*) FILTER (WHERE status IN ('APPROVED','EDITED','REJECTED')) AS decididos
           FROM pending_approvals WHERE created_at >= now() - interval '6 months'
          GROUP BY 1 ORDER BY 1`,
        []
      )
    ).rows;

    // HEATMAP: SEMPRE 90 dias, independente do filtro de período (mantém o de canal).
    const heatLeadsRaw = (
      await c.query(
        `WITH chan AS (
           SELECT regexp_replace(external_id, '[^0-9]', '', 'g') AS ident,
                  (array_agg(channel ORDER BY updated_at DESC))[1] AS channel
             FROM conversations WHERE tenant_id = $1 GROUP BY 1
         )
         SELECT l.created_at, c.channel
           FROM leads l
           LEFT JOIN chan c ON c.ident = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
          WHERE l.created_at >= now() - interval '90 days'
            AND l.status NOT IN ('NOT_LEAD', 'REVIEW_QUEUE')`,
        [tenantId]
      )
    ).rows;

    // ---- agregação em JS ---------------------------------------------------
    const rows = channel ? leads.filter((l) => l.channel === channel) : leads;
    const totalLeads = rows.length;

    // BLOCO 1 — SLA / responsividade
    const respTimes = []; // segundos até 1ª resposta
    let semResposta = 0, leadParou = 0, comInbound = 0;
    let em30 = 0, em2h = 0; // faixas de SLA: <=30min (verde), <=2h (verde+amarelo)
    // ADR-021 — estado AGORA: clientes esperando nossa resposta + leads silenciosos 3d+.
    const TRES_DIAS = 3 * 86400;
    const aguardandoLista = []; // { id, name, esperando_seg }
    let silenciosos3d = 0;
    const semRespostaLeads = []; // { id, name } — pro alerta com link direto
    const porRecep = new Map(); // sender -> { n, somaSeg, comTempo }
    const leadsTabela = []; // linha por lead pra seção "Lista de leads"
    const agora = Date.now();
    for (const l of rows) {
      const fin = l.first_in ? new Date(l.first_in).getTime() : null;
      const fout = l.first_out ? new Date(l.first_out).getTime() : null;
      const lin = l.last_in ? new Date(l.last_in).getTime() : null;
      const lout = l.last_out ? new Date(l.last_out).getTime() : null;
      if (fin) comInbound++;
      const respondido = fout != null && (fin == null || fout >= fin);
      const respSeg = (respondido && fin) ? Math.max(0, (fout - fin) / 1000) : null;
      if (fin && !respondido) { semResposta++; semRespostaLeads.push({ id: l.id, name: l.name || 'Lead sem nome' }); }
      if (respSeg != null) {
        respTimes.push(respSeg);
        if (respSeg <= 30 * 60) em30++;
        if (respSeg <= 120 * 60) em2h++;
        const key = l.first_sender || '(desconhecido)';
        const r = porRecep.get(key) || { n: 0, somaSeg: 0, comTempo: 0 };
        r.n++; r.somaSeg += respSeg; r.comTempo++;
        porRecep.set(key, r);
      }
      // "respondemos mas o lead parou": última palavra foi nossa.
      if (respondido && lout != null && (lin == null || lout > lin)) leadParou++;
      // ADR-021 — estado atual (só leads ativos): aguardando nós / silencioso 3d+.
      const ativo021 = !l.desfecho && l.status !== 'CONVERTED';
      if (ativo021 && lin != null && (lout == null || lin > lout)) {
        aguardandoLista.push({ id: l.id, name: l.name || 'Lead sem nome', esperando_seg: Math.max(0, Math.round((agora - lin) / 1000)) });
      } else if (ativo021 && lout != null && (agora - lout) / 1000 > TRES_DIAS) {
        silenciosos3d++;
      }
      // Tempo em aberto: respondido = tempo até a 1ª resposta; sem resposta = desde
      // a chegada (1º inbound, ou created_at se não houver) até agora.
      const chegada = fin || new Date(l.created_at).getTime();
      const abertoSeg = respondido ? respSeg : Math.max(0, (agora - chegada) / 1000);
      leadsTabela.push({
        id: l.id, name: l.name || 'Lead sem nome',
        channel: l.channel || null, instrument: l.instrument || null,
        status: l.status, temperatura: temperatura(l),
        respondido, resposta_seg: respSeg == null ? null : round(respSeg, 0),
        aberto_seg: round(abertoSeg, 0),
        ultimo_contato_lead: l.last_in || null, // última msg DO lead (role USER)
      });
    }
    respTimes.sort((a, b) => a - b);
    const ranking = [...porRecep.entries()]
      .map(([sender, r]) => ({ sender, volume: r.n, tempo_medio_seg: round(r.somaSeg / r.comTempo, 0) }))
      .sort((a, b) => b.volume - a.volume);

    // BLOCO 2 — funil / temperatura / heatmap / instrumento
    const funil = { NEW: 0, QUALIFYING: 0, QUALIFIED: 0, CONVERTED: 0, OUTRO: 0 };
    const temps = { quente: 0, morno: 0, frio: 0 };
    const instrProcura = new Map();
    const instrConvert = new Map();
    const porCanal = new Map();
    for (const l of rows) {
      funil[l.status in funil ? l.status : 'OUTRO']++;
      temps[temperatura(l)]++;
      if (l.instrument) {
        instrProcura.set(l.instrument, (instrProcura.get(l.instrument) || 0) + 1);
        if (l.desfecho === 'matriculado') instrConvert.set(l.instrument, (instrConvert.get(l.instrument) || 0) + 1);
      }
      const ch = l.channel || '(sem canal)';
      porCanal.set(ch, (porCanal.get(ch) || 0) + 1);
    }
    // Heatmap (90d fixos): aplica só o filtro de canal.
    const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const l of heatLeadsRaw) {
      if (channel && l.channel !== channel) continue;
      const { hour, dow } = spHourDow(l.created_at);
      heat[dow][hour]++;
    }

    // BLOCO 3 — desfechos (denominador = leads COM desfecho registrado)
    const comDesfecho = rows.filter((l) => l.desfecho);
    const matriculados = comDesfecho.filter((l) => l.desfecho === 'matriculado');
    const motivos = {};
    for (const l of comDesfecho) {
      if (l.desfecho === 'matriculado') continue;
      const lbl = NAO_MATRICULA[l.desfecho] || l.desfecho;
      motivos[lbl] = (motivos[lbl] || 0) + 1;
    }
    // matrícula por canal
    const matPorCanal = {};
    for (const l of comDesfecho) {
      const ch = l.channel || '(sem canal)';
      matPorCanal[ch] = matPorCanal[ch] || { com_desfecho: 0, matriculados: 0 };
      matPorCanal[ch].com_desfecho++;
      if (l.desfecho === 'matriculado') matPorCanal[ch].matriculados++;
    }
    // leads parados (sem desfecho) por faixa de inatividade
    const parados = { d7: 0, d15: 0, d30: 0 };
    for (const l of rows) {
      if (l.desfecho) continue;
      const ult = l.last_out || l.last_in || l.created_at;
      const dias = (agora - new Date(ult).getTime()) / 864e5;
      if (dias > 30) parados.d30++;
      else if (dias > 15) parados.d15++;
      else if (dias > 7) parados.d7++;
    }

    // BLOCO 4 — IA
    const aprovados = Number(appr.aprovados), editados = Number(appr.editados), rejeitados = Number(appr.rejeitados);
    const decididos = aprovados + editados + rejeitados;
    const evolucao = aceitMes.map((m) => ({
      mes: m.mes,
      taxa: Number(m.decididos) ? round((Number(m.aceitos) / Number(m.decididos)) * 100) : null,
    }));

    return {
      period, channel: channel || null, total_leads: totalLeads,
      leads_tabela: leadsTabela,
      bloco1_sla: {
        primeira_resposta_seg: {
          mediana: round(percentile(respTimes, 0.5), 0),
          media: respTimes.length ? round(respTimes.reduce((a, b) => a + b, 0) / respTimes.length, 0) : null,
          p90: round(percentile(respTimes, 0.9), 0),
        },
        respondidos: respTimes.length,
        sla_meta_min: 30,
        pct_em_30min: respTimes.length ? round((em30 / respTimes.length) * 100) : null,         // verde
        pct_30min_2h: respTimes.length ? round(((em2h - em30) / respTimes.length) * 100) : null, // amarelo
        pct_acima_2h: respTimes.length ? round(((respTimes.length - em2h) / respTimes.length) * 100) : null, // vermelho
        pct_sem_resposta: comInbound ? round((semResposta / comInbound) * 100) : null,
        sem_resposta_n: semResposta,
        sem_resposta_leads: semRespostaLeads,
        pct_lead_parou: comInbound ? round((leadParou / comInbound) * 100) : null,
        seg_rascunho_ate_decisao: appr.seg_ate_decisao != null ? round(Number(appr.seg_ate_decisao), 0) : null,
        taxa_edicao_global: decididos ? round((editados / decididos) * 100) : null,
        // ADR-021 — BLOCO A (estado AGORA) + BLOCO C (silenciosos).
        aguardando_agora: aguardandoLista.length,
        aguardando_mais_antigo_seg: aguardandoLista.length ? Math.max(...aguardandoLista.map((a) => a.esperando_seg)) : null,
        aguardando_lista: aguardandoLista.sort((a, b) => b.esperando_seg - a.esperando_seg).slice(0, 50),
        silenciosos_3d: silenciosos3d,
        reabordados_no_prazo: null,   // sem dados (futuro)
        taxa_retomada: null,          // sem dados (futuro)
      },
      bloco2_funil: {
        por_canal: Object.fromEntries(porCanal),
        funil,
        temperatura: temps,
        heatmap: heat,
        por_mes: porMes.map((m) => ({ mes: m.mes, n: Number(m.n) })),
        instrumento_procurado: Object.fromEntries([...instrProcura.entries()].sort((a, b) => b[1] - a[1])),
        instrumento_convertido: Object.fromEntries([...instrConvert.entries()].sort((a, b) => b[1] - a[1])),
      },
      bloco3_desfechos: {
        com_desfecho: comDesfecho.length,
        matriculados: matriculados.length,
        taxa_matricula: comDesfecho.length ? round((matriculados.length / comDesfecho.length) * 100) : null,
        matricula_por_canal: matPorCanal,
        motivos_nao_matricula: motivos,
        parados,
      },
      bloco4_ia: {
        aprovados, editados, rejeitados, decididos,
        backlog: Number(appr.backlog),
        taxa_aceitacao: decididos ? round(((aprovados + editados) / decididos) * 100) : null,
        evolucao_mensal: evolucao,
      },
    };
  });
}

// --- funil de conversão mensal ---------------------------------------------
function ym(y, m) { return `${y}-${String(m + 1).padStart(2, '0')}`; } // m: 0-based
// Resolve o período do funil: '6m' | '12m' | 'year:YYYY'. Devolve a lista de meses
// (YYYY-MM) + a janela [start, end) pra query.
function resolveFunilRange(fp) {
  const now = new Date();
  const y = now.getFullYear(), mo = now.getMonth();
  let months = [];
  const mYear = /^year:(\d{4})$/.exec(fp);
  if (mYear) {
    const yr = Number(mYear[1]);
    const ultimo = (yr === y) ? mo : 11; // ano corrente vai até o mês atual
    for (let m = 0; m <= ultimo; m++) months.push(ym(yr, m));
  } else if (fp === '12m') {
    for (let i = 11; i >= 0; i--) { const d = new Date(y, mo - i, 1); months.push(ym(d.getFullYear(), d.getMonth())); }
  } else { // 6m (padrão)
    fp = '6m';
    for (let i = 5; i >= 0; i--) { const d = new Date(y, mo - i, 1); months.push(ym(d.getFullYear(), d.getMonth())); }
  }
  const start = months[0] + '-01';
  const [ly, lm] = months[months.length - 1].split('-').map(Number); // lm: 1-based
  const end = `${lm === 12 ? ly + 1 : ly}-${String(lm === 12 ? 1 : lm + 1).padStart(2, '0')}-01`;
  return { period: fp, start, end, months };
}

function taxa(num, den) { return den ? round((num / den) * 100) : null; }

async function computeFunil(tenantId, { funilPeriod = '6m' } = {}) {
  const { period, start, end, months } = resolveFunilRange(funilPeriod);
  return withTenant(tenantId, async (c) => {
    const rows = (
      await c.query(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS mes,
                count(*) AS leads,
                count(*) FILTER (
                  WHERE intent = 'SCHEDULE_INTEREST' OR status = 'QUALIFIED' OR desfecho = 'nao_compareceu_aula'
                ) AS agendadas,
                count(*) FILTER (
                  WHERE (intent = 'SCHEDULE_INTEREST' OR status = 'QUALIFIED' OR desfecho = 'nao_compareceu_aula')
                    AND desfecho IS NOT NULL AND desfecho <> 'nao_compareceu_aula'
                ) AS realizadas,
                count(*) FILTER (WHERE desfecho = 'matriculado') AS matriculas
           FROM leads
          WHERE created_at >= $1::date AND created_at < $2::date
            AND status NOT IN ('NOT_LEAD', 'REVIEW_QUEUE')
          GROUP BY 1`,
        [start, end]
      )
    ).rows;
    const porMes = new Map(rows.map((r) => [r.mes, r]));
    // Preenche todos os meses do range (zera os ausentes — degrada elegante).
    const funil_mensal = months.map((mes) => {
      const r = porMes.get(mes) || {};
      return {
        mes,
        leads: Number(r.leads) || 0,
        agendadas: Number(r.agendadas) || 0,
        realizadas: Number(r.realizadas) || 0,
        matriculas: Number(r.matriculas) || 0,
      };
    });
    const tot = funil_mensal.reduce((a, m) => ({
      leads: a.leads + m.leads, agendadas: a.agendadas + m.agendadas,
      realizadas: a.realizadas + m.realizadas, matriculas: a.matriculas + m.matriculas,
    }), { leads: 0, agendadas: 0, realizadas: 0, matriculas: 0 });
    return {
      funil_period: period,
      funil_mensal,
      funil_taxas: {
        leads_agendada: taxa(tot.agendadas, tot.leads),
        agendada_realizada: taxa(tot.realizadas, tot.agendadas),
        realizada_matricula: taxa(tot.matriculas, tot.realizadas),
        total_leads_matricula: taxa(tot.matriculas, tot.leads),
      },
    };
  });
}

// --- painel da recepção (fila de ação do turno) ----------------------------
// Início do dia de hoje em America/Sao_Paulo (expressão SQL, sem input externo).
const SP_HOJE = `date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`;

async function computePainel(tenantId) {
  return withTenant(tenantId, async (c) => {
    const rows = (
      await c.query(
        `WITH inb AS (
           SELECT regexp_replace(cv.external_id, '[^0-9]', '', 'g') AS ident,
                  min(m.received_at) AS first_in, max(m.received_at) AS last_in
             FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
            WHERE cv.tenant_id = $1 AND m.role = 'USER' GROUP BY 1
         ),
         outb AS (
           SELECT regexp_replace(s.external_id, '[^0-9]', '', 'g') AS ident,
                  min(s.received_at) AS first_out, max(s.received_at) AS last_out
             FROM staff_outbound_samples s
            WHERE s.tenant_id = $1 AND coalesce(s.raw->'data'->'key'->>'remoteJid', '') NOT LIKE '%@g.us'
            GROUP BY 1
         ),
         chan AS (
           SELECT regexp_replace(external_id, '[^0-9]', '', 'g') AS ident,
                  (array_agg(channel ORDER BY updated_at DESC))[1] AS channel
             FROM conversations WHERE tenant_id = $1 GROUP BY 1
         ),
         draft AS (
           SELECT lead_id, max(created_at) AS draft_at, count(*) AS n
             FROM pending_approvals WHERE tenant_id = $1 AND status = 'PENDING' GROUP BY 1
         )
         SELECT l.id, l.name, l.status, l.intent, l.desfecho, l.created_at, l.temperatura_manual,
                l.review_queue, l.review_result, l.classification_confidence,
                q.instrument, COALESCE(q.qualification_complete, false) AS qualif,
                i.first_in, i.last_in, o.first_out, o.last_out, c.channel,
                d.draft_at, COALESCE(d.n, 0) AS drafts
           FROM leads l
           LEFT JOIN lead_qualifications q ON q.lead_id = l.id
           LEFT JOIN inb  i ON i.ident = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
           LEFT JOIN outb o ON o.ident = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
           LEFT JOIN chan c ON c.ident = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
           LEFT JOIN draft d ON d.lead_id = l.id`,
        [tenantId]
      )
    ).rows;

    const hojeRow = (
      await c.query(
        `SELECT
           (SELECT count(DISTINCT regexp_replace(external_id, '[^0-9]', '', 'g'))
              FROM staff_outbound_samples
             WHERE tenant_id = $1 AND coalesce(raw->'data'->'key'->>'remoteJid', '') NOT LIKE '%@g.us'
               AND received_at >= ${SP_HOJE}) AS leads_respondidos,
           (SELECT count(*) FROM pending_approvals WHERE tenant_id = $1 AND status = 'APPROVED' AND decided_at >= ${SP_HOJE}) AS aprovados,
           (SELECT count(*) FROM pending_approvals WHERE tenant_id = $1 AND status = 'EDITED'   AND decided_at >= ${SP_HOJE}) AS editados`,
        [tenantId]
      )
    ).rows[0];

    const agora = Date.now();
    const dsp = new Date(agora - 3 * 3600 * 1000);
    const spTodayMs = Date.UTC(dsp.getUTCFullYear(), dsp.getUTCMonth(), dsp.getUTCDate()) + 3 * 3600 * 1000;

    const fila = [];
    const tempoHoje = [];
    const TRES_DIAS = 3 * 86400 * 1000;
    let leadsAtivos = 0, aguardando = 0, comRascunho = 0;
    for (const l of rows) {
      // Leads na fila de revisão ficam SÓ na aba "Revisar" (não na fila de ação).
      if (l.review_queue && !l.review_result) { comRascunho += l.drafts > 0 ? 1 : 0; continue; }
      const ativo = !l.desfecho && l.status !== 'CONVERTED';
      if (!ativo) continue;
      const fin = l.first_in ? new Date(l.first_in).getTime() : null;
      const fout = l.first_out ? new Date(l.first_out).getTime() : null;
      const lin = l.last_in ? new Date(l.last_in).getTime() : null;
      const lout = l.last_out ? new Date(l.last_out).getTime() : null;
      leadsAtivos++;
      if (l.drafts > 0) comRascunho++;
      if (fout != null && fout >= spTodayMs && fin != null) tempoHoje.push((fout - fin) / 1000);

      // ADR-021 — hierarquia por recência do último contato.
      const ultLead = lin != null && (lout == null || lin > lout);   // último contato foi DO lead
      let tipo, detalheSeg;
      if (ultLead) {
        tipo = fout == null ? 'sem_resposta' : 'responder_agora';    // nunca respondemos vs respondemos e voltou
        detalheSeg = (agora - lin) / 1000;
        aguardando++;                                                // bucket 1 + 2
      } else if (lout != null) {                                     // último contato foi DA escola
        detalheSeg = (agora - lout) / 1000;
        tipo = (agora - lout) > TRES_DIAS ? 'retomada' : 'monitorar';
      } else {
        tipo = 'monitorar';
        detalheSeg = (agora - new Date(l.created_at).getTime()) / 1000;
      }
      fila.push({
        id: l.id, name: l.name || 'Lead sem nome',
        instrument: l.instrument || null, channel: l.channel || null,
        temperatura: temperatura(l), tipo, detalhe_seg: Math.max(0, Math.round(detalheSeg)),
        tem_rascunho: l.drafts > 0,
      });
    }
    const ordem = { responder_agora: 0, sem_resposta: 1, retomada: 2, monitorar: 3 };
    fila.sort((a, b) => (ordem[a.tipo] - ordem[b.tipo]) || (b.detalhe_seg - a.detalhe_seg));

    return {
      fila,
      hoje: {
        leads_respondidos: Number(hojeRow.leads_respondidos) || 0,
        tempo_medio_seg: tempoHoje.length ? Math.round(tempoHoje.reduce((a, b) => a + b, 0) / tempoHoje.length) : null,
        aprovados: Number(hojeRow.aprovados) || 0,
        editados: Number(hojeRow.editados) || 0,
      },
      resumo: { leads_ativos: leadsAtivos, aguardando_resposta: aguardando, com_rascunho_pendente: comRascunho },
    };
  });
}

module.exports = { computeMetrics, computeFunil, computePainel, resolveFunilRange, percentile, temperatura, spHourDow, PERIODS };
