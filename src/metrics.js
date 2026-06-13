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
           SELECT l.id, l.name, l.status, l.intent, l.created_at, l.desfecho, l.desfecho_em,
                  regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g') AS ident,
                  q.instrument, COALESCE(q.qualification_complete, false) AS qualif
             FROM leads l
             LEFT JOIN lead_qualifications q ON q.lead_id = l.id
            WHERE l.created_at >= now() - ($2 || ' days')::interval
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
         SELECT b.id, b.name, b.status, b.intent, b.created_at, b.desfecho, b.desfecho_em,
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
          WHERE l.created_at >= now() - interval '90 days'`,
        [tenantId]
      )
    ).rows;

    // ---- agregação em JS ---------------------------------------------------
    const rows = channel ? leads.filter((l) => l.channel === channel) : leads;
    const totalLeads = rows.length;

    // BLOCO 1 — SLA / responsividade
    const respTimes = []; // segundos até 1ª resposta
    let semResposta = 0, leadParou = 0, comInbound = 0;
    let em15 = 0, em1h = 0;
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
        if (respSeg <= 15 * 60) em15++;
        if (respSeg <= 60 * 60) em1h++;
        const key = l.first_sender || '(desconhecido)';
        const r = porRecep.get(key) || { n: 0, somaSeg: 0, comTempo: 0 };
        r.n++; r.somaSeg += respSeg; r.comTempo++;
        porRecep.set(key, r);
      }
      // "respondemos mas o lead parou": última palavra foi nossa.
      if (respondido && lout != null && (lin == null || lout > lin)) leadParou++;
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
        pct_em_15min: respTimes.length ? round((em15 / respTimes.length) * 100) : null,
        pct_em_1h: respTimes.length ? round((em1h / respTimes.length) * 100) : null,
        pct_sem_resposta: comInbound ? round((semResposta / comInbound) * 100) : null,
        sem_resposta_n: semResposta,
        sem_resposta_leads: semRespostaLeads,
        pct_lead_parou: comInbound ? round((leadParou / comInbound) * 100) : null,
        ranking_recepcao: ranking,
        seg_rascunho_ate_decisao: appr.seg_ate_decisao != null ? round(Number(appr.seg_ate_decisao), 0) : null,
        taxa_edicao_global: decididos ? round((editados / decididos) * 100) : null,
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

module.exports = { computeMetrics, computeFunil, resolveFunilRange, percentile, temperatura, spHourDow, PERIODS };
