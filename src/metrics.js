'use strict';
//
// metrics.js — agregações do dashboard de gestão (G). Uma query "fatos por lead"
// + agregados de aprovação/mês-a-mês; o grosso do cálculo (SLA, percentis,
// temperatura, heatmap) é feito em JS aqui, pra ficar testável.
//
const { withTenant } = require('./db');

const PERIODS = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 };

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
// Dia-calendário (YYYY-MM-DD) em America/Sao_Paulo — pra séries diárias.
function spDay(ts) {
  return new Date(new Date(ts).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
// Faixa de silêncio (PARTE 3): 3-7 / 7-15 / +15 dias.
function faixaSilencio(dias) {
  if (dias > 15) return 'd15_mais';
  if (dias > 7) return 'd7_15';
  return 'd3_7';
}
// Horário comercial — minuto-do-dia + dia-da-semana ISO (1=Seg..7=Dom) em SP.
function spMinDow(ts) {
  const x = new Date(new Date(ts).getTime() - 3 * 3600 * 1000);
  return { mins: x.getUTCHours() * 60 + x.getUTCMinutes(), isoDow: x.getUTCDay() === 0 ? 7 : x.getUTCDay() };
}
function parseHM(t, def) {
  if (!t) return def;
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function fmtHM(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
// true = ts caiu dentro do expediente; false = fora; null = sem ts.
function dentroHorario(ts, horario) {
  if (!ts || !horario) return null;
  const { mins, isoDow } = spMinDow(ts);
  if (!horario.dias.includes(isoDow)) return false;
  return mins >= horario.inicio && mins < horario.fim;
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
// ---------------------------------------------------------------------------
// Engajamento do CLIENTE (ADR). Classifica um lead pela MEDIANA do tempo que ele
// leva para responder às NOSSAS mensagens. inbTs = msgs do cliente (role USER);
// outTs = nossas msgs (staff_outbound). Timestamps em epoch (segundos).
//   alto      mediana <= 1h
//   normal    1h–24h
//   baixo     > 24h
//   silenciou última msg foi nossa e passou >= 3 dias sem resposta
// ---------------------------------------------------------------------------
const ENGAJ_TRES_DIAS_SEG = 3 * 86400;
function classificarEngajamento(inbTs, outTs, nowSec) {
  const inb = (inbTs || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const out = (outTs || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  // gaps: cada nossa msg -> 1ª resposta do cliente antes da próxima nossa.
  const gaps = [];
  for (let i = 0; i < out.length; i++) {
    const t0 = out[i];
    const tNext = i + 1 < out.length ? out[i + 1] : Infinity;
    for (const t of inb) { if (t > t0 && t < tNext) { gaps.push(t - t0); break; } }
  }
  // trocas bidirecionais = mudanças de direção na timeline mesclada.
  const ev = [];
  for (const t of inb) ev.push([t, 0]);
  for (const t of out) ev.push([t, 1]);
  ev.sort((a, b) => a[0] - b[0]);
  let trocas = 0;
  for (let i = 1; i < ev.length; i++) if (ev[i][1] !== ev[i - 1][1]) trocas++;
  const lastIn = inb.length ? inb[inb.length - 1] : -Infinity;
  const lastOut = out.length ? out[out.length - 1] : -Infinity;
  const silenciou = out.length > 0 && lastOut > lastIn && (nowSec - lastOut) >= ENGAJ_TRES_DIAS_SEG;
  const mediana = gaps.length ? percentile([...gaps].sort((a, b) => a - b), 0.5) : null;
  let engajamento = null;
  if (silenciou) engajamento = 'silenciou';
  else if (mediana != null) engajamento = mediana <= 3600 ? 'alto' : (mediana <= 86400 ? 'normal' : 'baixo');
  return {
    engajamento,
    tempo_medio_resposta_cliente_seg: mediana != null ? Math.round(mediana) : null,
    trocas, respondeu: gaps.length > 0, silenciou, tem_outbound: out.length > 0, gaps,
  };
}

// Segunda-feira (YYYY-MM-DD) da semana de um timestamp, em horário de SP.
function mondaySP(ts) {
  const x = new Date(new Date(ts).getTime() - 3 * 3600 * 1000); // wall clock SP como UTC
  const dow = x.getUTCDay();                 // 0=Dom..6=Sáb
  x.setUTCDate(x.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return x.toISOString().slice(0, 10);
}

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

    // 2b) HORÁRIO COMERCIAL do tenant (separa SLA dentro/fora do expediente).
    const cfgH = (
      await c.query(
        `SELECT horario_comercial_inicio AS inicio, horario_comercial_fim AS fim, horario_comercial_dias AS dias
           FROM tenants WHERE id = $1`,
        [tenantId]
      )
    ).rows[0] || {};
    const horario = {
      inicio: parseHM(cfgH.inicio, 8 * 60),
      fim: parseHM(cfgH.fim, 18 * 60),
      dias: (Array.isArray(cfgH.dias) && cfgH.dias.length ? cfgH.dias : [1, 2, 3, 4, 5]).map(Number),
    };

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

    // REABORDAGENS (BLOCO C): tentativas no período + quantas o lead respondeu
    // DEPOIS (calculado na leitura — sem job de fundo; `respondeu` fica null no envio).
    const reab = (
      await c.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM messages m
                    JOIN conversations cv ON cv.id = m.conversation_id
                   WHERE cv.tenant_id = $1 AND m.role = 'USER'
                     AND regexp_replace(cv.external_id, '[^0-9]', '', 'g')
                         = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
                     AND m.received_at > rt.enviado_em
                ))::int AS responderam
           FROM reabordagem_tentativas rt
           JOIN leads l ON l.id = rt.lead_id
          WHERE rt.tenant_id = $1 AND rt.enviado_em >= now() - ($2 || ' days')::interval`,
        [tenantId, days]
      )
    ).rows[0];
    // Leads que já têm ALGUMA reabordagem registrada (pro % de silenciosos reabordados).
    const reabIds = new Set(
      (await c.query('SELECT DISTINCT lead_id FROM reabordagem_tentativas WHERE tenant_id = $1', [tenantId]))
        .rows.map((r) => r.lead_id)
    );

    // ---- agregação em JS ---------------------------------------------------
    const rows = channel ? leads.filter((l) => l.channel === channel) : leads;
    const totalLeads = rows.length;

    // BLOCO 1 — SLA / responsividade
    const respTimes = []; // segundos até 1ª resposta
    const respComercial = [], respFora = []; // split por horário comercial (1ª msg do lead)
    let semResposta = 0, leadParou = 0, comInbound = 0;
    let em30 = 0, em2h = 0; // faixas de SLA: <=30min (verde), <=2h (verde+amarelo)
    // ADR-021 — estado AGORA: clientes esperando nossa resposta + leads silenciosos 3d+.
    const TRES_DIAS = 3 * 86400;
    const aguardandoLista = []; // { id, name, esperando_seg }
    let silenciosos3d = 0;
    const silenciososLista = []; // PARTE 3 — { id, name, instrument, ultimo_contato_em, silencio_seg, faixa }
    const respPorDia = new Map(); // PARTE 4 — dia(YYYY-MM-DD) -> { soma, n } (tempo de 1ª resposta)
    const slaSemana = new Map();  // SLA semanal — semana(segunda) -> { ate_30, ate_1h, ate_2h, acima_2h }
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
      if (fin && !respondido) {
        semResposta++;
        semRespostaLeads.push({
          id: l.id, name: l.name || 'Lead sem nome',
          channel: l.channel || null, instrument: l.instrument || null,
          chegou_em: l.first_in, chegou_seg: Math.max(0, Math.round((agora - fin) / 1000)),
        });
      }
      if (respSeg != null) {
        respTimes.push(respSeg);
        if (respSeg <= 30 * 60) em30++;
        if (respSeg <= 120 * 60) em2h++;
        const key = l.first_sender || '(desconhecido)';
        const r = porRecep.get(key) || { n: 0, somaSeg: 0, comTempo: 0 };
        r.n++; r.somaSeg += respSeg; r.comTempo++;
        porRecep.set(key, r);
        // PARTE 4 — tendência diária: tempo médio + % em 30min (dia da nossa resposta).
        const dia = spDay(l.first_out);
        const rd = respPorDia.get(dia) || { soma: 0, n: 0, em30: 0 };
        rd.soma += respSeg; rd.n++; if (respSeg <= 30 * 60) rd.em30++;
        respPorDia.set(dia, rd);
        // SLA semanal: bucketiza o tempo de 1ª resposta por semana (segunda, SP).
        const wk = mondaySP(l.first_out);
        const ws = slaSemana.get(wk) || { ate_30: 0, ate_1h: 0, ate_2h: 0, acima_2h: 0 };
        if (respSeg <= 1800) ws.ate_30++;
        else if (respSeg <= 3600) ws.ate_1h++;
        else if (respSeg <= 7200) ws.ate_2h++;
        else ws.acima_2h++;
        slaSemana.set(wk, ws);
        // Split por horário comercial: classifica pela chegada da 1ª msg do lead.
        if (dentroHorario(l.first_in, horario)) respComercial.push(respSeg);
        else respFora.push(respSeg);
      }
      // "respondemos mas o lead parou": última palavra foi nossa.
      if (respondido && lout != null && (lin == null || lout > lin)) leadParou++;
      // ADR-021 — estado atual (só leads ativos): aguardando nós / silencioso 3d+.
      const ativo021 = !l.desfecho && l.status !== 'CONVERTED';
      if (ativo021 && lin != null && (lout == null || lin > lout)) {
        aguardandoLista.push({ id: l.id, name: l.name || 'Lead sem nome', ultimo_contato_em: l.last_in, esperando_seg: Math.max(0, Math.round((agora - lin) / 1000)) });
      } else if (ativo021 && lout != null && (agora - lout) / 1000 > TRES_DIAS) {
        silenciosos3d++;
        const silSeg = Math.round((agora - lout) / 1000);
        silenciososLista.push({
          id: l.id, name: l.name || 'Lead sem nome',
          instrument: l.instrument || null,
          ultimo_contato_em: l.last_out,
          silencio_seg: silSeg,
          faixa: faixaSilencio(silSeg / 86400),
          reabordado: reabIds.has(l.id),
        });
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
    // SLA de um grupo de tempos de resposta (dentro/fora do expediente).
    const grupoSla = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      const em30 = s.filter((v) => v <= 30 * 60).length;
      return {
        n: s.length,
        pct_em_30min: s.length ? round((em30 / s.length) * 100) : null,
        tempo_medio_seg: s.length ? round(s.reduce((a, b) => a + b, 0) / s.length, 0) : null,
        p90_seg: round(percentile(s, 0.9), 0),
      };
    };
    const porHorario = { comercial: grupoSla(respComercial), fora: grupoSla(respFora) };
    const horarioInfo = { inicio: fmtHM(horario.inicio), fim: fmtHM(horario.fim), dias: horario.dias };
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

    // ENGAJAMENTO DO CLIENTE — sequências de mensagens por lead ATIVO do período.
    const engRows = (
      await c.query(
        `WITH base AS (
           SELECT l.id, regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g') AS ident
             FROM leads l
            WHERE l.created_at >= now() - ($2 || ' days')::interval
              AND l.status NOT IN ('NOT_LEAD', 'REVIEW_QUEUE', 'CONVERTED')
              AND l.desfecho IS NULL
         ),
         inb AS (
           SELECT regexp_replace(cv.external_id, '[^0-9]', '', 'g') AS ident,
                  array_agg(EXTRACT(EPOCH FROM m.received_at) ORDER BY m.received_at) AS ts
             FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
            WHERE cv.tenant_id = $1 AND m.role = 'USER' GROUP BY 1
         ),
         outb AS (
           SELECT regexp_replace(s.external_id, '[^0-9]', '', 'g') AS ident,
                  array_agg(EXTRACT(EPOCH FROM s.received_at) ORDER BY s.received_at) AS ts
             FROM staff_outbound_samples s
            WHERE s.tenant_id = $1
              AND coalesce(s.raw->'data'->'key'->>'remoteJid', '') NOT LIKE '%@g.us'
            GROUP BY 1
         )
         SELECT b.id, i.ts AS inb_ts, o.ts AS out_ts
           FROM base b
           LEFT JOIN inb  i ON i.ident = b.ident AND b.ident <> ''
           LEFT JOIN outb o ON o.ident = b.ident AND b.ident <> ''`,
        [tenantId, days]
      )
    ).rows;
    const nowSec = agora / 1000;
    let engComOut = 0, engResp = 0, engAtiva = 0, engSil = 0;
    const engDist = { alto: 0, normal: 0, baixo: 0, silenciou: 0 };
    const engGaps = [];
    for (const r of engRows) {
      const e = classificarEngajamento(r.inb_ts, r.out_ts, nowSec);
      if (e.tem_outbound) engComOut++;
      if (e.respondeu) engResp++;
      if (e.trocas >= 3) engAtiva++;
      if (e.silenciou) engSil++;
      if (e.engajamento) engDist[e.engajamento]++;
      for (const g of e.gaps) engGaps.push(g);
    }
    engGaps.sort((a, b) => a - b);
    const engajamento = {
      taxa_retorno_pct: engComOut ? round((engResp / engComOut) * 100) : 0,
      tempo_medio_cliente_seg: engGaps.length ? Math.round(percentile(engGaps, 0.5)) : null,
      leads_conversa_ativa: engAtiva,
      leads_silenciosos_apos_resposta: engSil,
      distribuicao: engDist,
    };

    const bloco_sla_semanal = [...slaSemana.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([semana, v]) => ({ semana, ...v }));

    return {
      period, channel: channel || null, total_leads: totalLeads,
      leads_tabela: leadsTabela,
      engajamento,
      bloco_sla_semanal,
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
        reabordados_no_prazo: Number(reab.total) || 0,
        taxa_retomada: Number(reab.total) ? round((Number(reab.responderam) / Number(reab.total)) * 100) : null,
        // Separação por horário comercial (dentro = real da equipe; fora = impacto sem automação).
        por_horario: porHorario,
        horario_comercial: horarioInfo,
      },
      // PARTE 3 — leads silenciosos (cliente parou; aguardam retomada).
      bloco_silenciosos: {
        total: silenciososLista.length,
        silencio_medio_seg: silenciososLista.length
          ? Math.round(silenciososLista.reduce((a, s) => a + s.silencio_seg, 0) / silenciososLista.length) : null,
        distribuicao: {
          d3_7: silenciososLista.filter((s) => s.faixa === 'd3_7').length,
          d7_15: silenciososLista.filter((s) => s.faixa === 'd7_15').length,
          d15_mais: silenciososLista.filter((s) => s.faixa === 'd15_mais').length,
        },
        // Cobrável (ADR-009 B4): % dos silenciosos que já têm reabordagem registrada.
        reabordados: silenciososLista.filter((s) => s.reabordado).length,
        pct_reabordados: silenciososLista.length
          ? round((silenciososLista.filter((s) => s.reabordado).length / silenciososLista.length) * 100) : null,
        lista: silenciososLista.sort((a, b) => b.silencio_seg - a.silencio_seg).slice(0, 100),
      },
      // PARTE 4 — desempenho da recepção quando RESPONDE o cliente.
      bloco_respostas: {
        total_respostas: respTimes.length,
        tempo_medio_seg: respTimes.length ? round(respTimes.reduce((a, b) => a + b, 0) / respTimes.length, 0) : null,
        pct_em_30min: respTimes.length ? round((em30 / respTimes.length) * 100) : null,
        pct_em_2h: respTimes.length ? round((em2h / respTimes.length) * 100) : null,
        pct_acima_2h: respTimes.length ? round(((respTimes.length - em2h) / respTimes.length) * 100) : null,
        tendencia_diaria: [...respPorDia.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([dia, r]) => ({ dia, media_seg: round(r.soma / r.n, 0), n: r.n, pct_em_30min: r.n ? round((r.em30 / r.n) * 100) : null })),
        por_horario: porHorario,
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
                  min(m.received_at) AS first_in, max(m.received_at) AS last_in,
                  array_agg(EXTRACT(EPOCH FROM m.received_at) ORDER BY m.received_at) AS ts_in
             FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
            WHERE cv.tenant_id = $1 AND m.role = 'USER' GROUP BY 1
         ),
         outb AS (
           SELECT regexp_replace(s.external_id, '[^0-9]', '', 'g') AS ident,
                  min(s.received_at) AS first_out, max(s.received_at) AS last_out,
                  array_agg(EXTRACT(EPOCH FROM s.received_at) ORDER BY s.received_at) AS ts_out
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
         ),
         pend AS (
           SELECT lead_id FROM reabordagem_tentativas
            WHERE tenant_id = $1 AND status = 'pendente' GROUP BY lead_id
         )
         SELECT l.id, l.name, l.status, l.intent, l.desfecho, l.created_at, l.temperatura_manual,
                l.review_queue, l.review_result, l.classification_confidence,
                q.instrument, COALESCE(q.qualification_complete, false) AS qualif,
                i.first_in, i.last_in, o.first_out, o.last_out, c.channel,
                i.ts_in, o.ts_out,
                d.draft_at, COALESCE(d.n, 0) AS drafts,
                (p.lead_id IS NOT NULL) AS retomada_pendente
           FROM leads l
           LEFT JOIN lead_qualifications q ON q.lead_id = l.id
           LEFT JOIN inb  i ON i.ident = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
           LEFT JOIN outb o ON o.ident = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
           LEFT JOIN chan c ON c.ident = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
           LEFT JOIN draft d ON d.lead_id = l.id
           LEFT JOIN pend p ON p.lead_id = l.id`,
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
      // Leads não-reais ficam fora da fila de ação (igual ao funil): NOT_LEAD/REVIEW_QUEUE.
      const ativo = !l.desfecho && l.status !== 'CONVERTED'
        && l.status !== 'NOT_LEAD' && l.status !== 'REVIEW_QUEUE';
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
      // P5 — engajamento do cliente + bump: 🔴 silenciou sobe pro bucket retomada.
      const eng = classificarEngajamento(l.ts_in, l.ts_out, agora / 1000);
      const silenciouEng = eng.engajamento === 'silenciou';
      if (silenciouEng && tipo === 'monitorar') tipo = 'retomada';
      fila.push({
        id: l.id, name: l.name || 'Lead sem nome',
        instrument: l.instrument || null, channel: l.channel || null,
        temperatura: temperatura(l), tipo, detalhe_seg: Math.max(0, Math.round(detalheSeg)),
        tem_rascunho: l.drafts > 0,
        retomada_sugerida: !!l.retomada_pendente || (silenciouEng && tipo === 'retomada'),   // ADR-020 + P5
        engajamento_cliente: {
          engajamento: eng.engajamento,
          tempo_medio_resposta_cliente_seg: eng.tempo_medio_resposta_cliente_seg,
        },
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

// --- ADR-010 — Kanban do ciclo de vida -------------------------------------
const KANBAN_PERIODS = { '30d': 30, '90d': 90 };
// Desfechos de "perda" (não-matrícula). 'nao_e_lead' NÃO entra (é spam/interno).
const PERDIDO_DESFECHOS = [
  'nao_matriculado_preco', 'nao_matriculado_horario', 'nao_matriculado_concorrente',
  'nao_matriculado_desistiu', 'nao_compareceu_aula', 'outro',
];
// Coluna do kanban a partir de status + desfecho (modelo ADR-011: desfecho dirige
// o desfecho final; PERDIDO preserva o status — NÃO vira NOT_LEAD).
function kanbanColuna(status, desfecho) {
  if (PERDIDO_DESFECHOS.includes(desfecho)) return 'perdido';
  if (desfecho === 'matriculado' || status === 'CONVERTED') return 'convertido';
  if (status === 'NEW') return 'novo';
  if (status === 'QUALIFIED') return 'qualificado';
  return 'qualificando';
}
// Transições permitidas (origem -> destinos). Terminais não saem.
const KANBAN_TRANSICOES = {
  novo: ['qualificando', 'qualificado', 'convertido', 'perdido'],
  qualificando: ['qualificado', 'convertido', 'perdido'],
  qualificado: ['convertido', 'perdido'],
  convertido: [],
  perdido: [],
};

async function computeKanban(tenantId, { period = '30d' } = {}) {
  const days = KANBAN_PERIODS[period] || 30;
  return withTenant(tenantId, async (c) => {
    const rows = (
      await c.query(
        `WITH inb AS (
           SELECT regexp_replace(cv.external_id, '[^0-9]', '', 'g') AS ident,
                  max(m.received_at) AS last_in
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
           SELECT lead_id, count(*) AS n FROM pending_approvals
            WHERE tenant_id = $1 AND status = 'PENDING' GROUP BY 1
         )
         SELECT l.id, l.name, l.phone, l.status, l.intent, l.desfecho, l.desfecho_em, l.created_at, l.temperatura_manual,
                q.instrument, COALESCE(q.qualification_complete, false) AS qualif,
                i.last_in, o.first_out, o.last_out, c.channel, COALESCE(d.n, 0) AS drafts
           FROM leads l
           LEFT JOIN lead_qualifications q ON q.lead_id = l.id
           LEFT JOIN inb  i ON i.ident = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
           LEFT JOIN outb o ON o.ident = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
           LEFT JOIN chan c ON c.ident = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
           LEFT JOIN draft d ON d.lead_id = l.id
          WHERE l.created_at >= now() - ($2 || ' days')::interval
            AND l.status NOT IN ('NOT_LEAD', 'REVIEW_QUEUE')
            AND coalesce(l.desfecho, '') <> 'nao_e_lead'`,
        [tenantId, days]
      )
    ).rows;

    const agora = Date.now();
    const cols = { novo: [], qualificando: [], qualificado: [], convertido: [], perdido: [] };
    for (const l of rows) {
      const lin = l.last_in ? new Date(l.last_in).getTime() : null;
      const lout = l.last_out ? new Date(l.last_out).getTime() : null;
      const fout = l.first_out ? new Date(l.first_out).getTime() : null;
      // urgência: último contato foi DO lead e estamos devendo resposta.
      const ultLead = lin != null && (lout == null || lin > lout);
      let bucket = null, esperandoSeg = null;
      if (ultLead) { bucket = fout == null ? 'sem_resposta' : 'responder_agora'; esperandoSeg = Math.max(0, Math.round((agora - lin) / 1000)); }
      const ultimaMsgMs = Math.max(lin || 0, lout || 0) || null;
      const coluna = kanbanColuna(l.status, l.desfecho);
      // tempo na coluna (aprox.): terminais desde desfecho_em; ativos desde created_at.
      const ref = (coluna === 'perdido' || coluna === 'convertido') && l.desfecho_em ? l.desfecho_em : l.created_at;
      cols[coluna].push({
        id: l.id, name: l.name || 'Lead sem nome', phone: l.phone || null,
        instrument: l.instrument || null, channel: l.channel || null,
        temperature: temperatura(l), status: l.status, desfecho: l.desfecho || null,
        created_at: l.created_at,
        ultima_msg_em: ultimaMsgMs ? new Date(ultimaMsgMs).toISOString() : null,
        tem_rascunho: l.drafts > 0, bucket_urgencia: bucket, esperando_seg: esperandoSeg,
        tempo_coluna_seg: Math.max(0, Math.round((agora - new Date(ref).getTime()) / 1000)),
      });
    }
    // ordena: urgentes primeiro, depois mais recentes.
    const ord = (a, b) => ((b.bucket_urgencia ? 1 : 0) - (a.bucket_urgencia ? 1 : 0)) || (new Date(b.created_at) - new Date(a.created_at));
    for (const k of Object.keys(cols)) cols[k].sort(ord);
    return { period: KANBAN_PERIODS[period] ? period : '30d', ...cols };
  });
}

module.exports = {
  computeMetrics, computeFunil, computePainel, computeKanban,
  kanbanColuna, KANBAN_TRANSICOES, PERDIDO_DESFECHOS,
  resolveFunilRange, percentile, temperatura, spHourDow, PERIODS,
  classificarEngajamento,
};
