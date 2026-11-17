'use strict';
//
// ingestaoLatencia.js — O RELÓGIO DA ENTRADA.
//
// Responde a UMA pergunta, pedida pelo Leo em 16/11/2026: quanto tempo passa entre a mensagem do
// cliente chegar no Lead Manager e o lead existir? Ela decide o desenho do aviso "no instante"
// (docs/proposta-aviso-lead-novo.md, D2): se a mediana for 3 segundos, avisar só no fim é
// suficiente; se for 40, o aviso precisa sair antes da IA e se corrigir depois.
//
// Até aqui ninguém media: não havia UM registro de duração em src/gemini.js nem em src/engine.js.
//
// TRÊS REGRAS QUE ESTE ARQUIVO NÃO QUEBRA:
//
//   1. NUNCA derruba a ingestão. Um cronômetro que faz a mensagem do cliente se perder é pior que
//      a dúvida que ele resolve. Tudo aqui é best-effort e engole o próprio erro.
//   2. NUNCA entra no caminho crítico. O registro roda DEPOIS de o funil terminar, sem `await` do
//      chamador — o tempo de gravar a medição não conta na medição nem atrasa o cliente.
//   3. NUNCA guarda telefone, nome ou texto. É cronômetro, não espelho da conversa.
//
// ⚠ E A REGRA QUE PROTEGE A PRÓPRIA MEDIÇÃO: silêncio aqui é indistinguível de "nada aconteceu".
//   Se a gravação falhar, a tabela fica vazia e a leitura diria "zero mensagens" — um número
//   plausível e falso, que é a família de defeito que este projeto já catalogou. Por isso a falha
//   de gravação é REGISTRADA no log (uma vez por causa, sem repetir), em vez de engolida calada.
//
const { withTenant } = require('./db');
const logger = require('./logger');

// Ligado por padrão: um instrumento que nasce desligado mede zero e ninguém percebe.
// Para desligar em produção sem deploy de código: MEDIR_LATENCIA_INGESTAO=off
const LIGADO = String(process.env.MEDIR_LATENCIA_INGESTAO || '').toLowerCase() !== 'off';

// Dedupe do aviso de falha: a causa aparece uma vez, a repetição cala. Reiniciar o contêiner
// re-arma o aviso — que é o comportamento desejado depois de um deploy.
let _ultimaFalha = null;

/**
 * Cronômetro de fases. Uso:
 *   const cron = iniciar();
 *   await origem();        cron.fase('origem_ms');
 *   await midia();         cron.fase('midia_ms');
 *   await funil();         cron.fase('funil_ms');
 *
 * `fase(nome)` mede desde a fase anterior (ou desde o início, na primeira).
 */
function iniciar(agora = Date.now()) {
  const t0 = agora;
  let marca = t0;
  const fases = {};
  return {
    t0,
    fase(nome, quando = Date.now()) { fases[nome] = quando - marca; marca = quando; return fases[nome]; },
    fases,
    totalMs(quando = Date.now()) { return quando - t0; },
  };
}

// Fila = do envio (relógio do WhatsApp) até a chegada (nosso relógio). Mede Evolution +
// despachante de webhooks. PODE SER NEGATIVO — relógios diferentes discordam —, e devolver o
// negativo é o certo: quem lê descarta o absurdo. Fingir zero esconderia o desvio.
// messageTimestamp do WhatsApp vem em SEGUNDOS.
function filaMs(messageTimestamp, recebidoEmMs) {
  const seg = Number(messageTimestamp);
  if (!Number.isFinite(seg) || seg <= 0) return null;
  return recebidoEmMs - Math.round(seg * 1000);
}

/**
 * Grava uma medição. Best-effort: nunca lança, nunca bloqueia o chamador.
 *
 * @param {string} tenantId
 * @param {object} p
 * @param {ReturnType<iniciar>} p.cron        cronômetro já com as fases marcadas
 * @param {string|null} p.externalMessageId
 * @param {number|null} p.messageTimestamp    segundos, como o WhatsApp manda
 * @param {string|null} p.tipoMidia           'audio' | 'image' | ... | null
 * @param {string|null} p.identBruto          jid/telefone do contato — usado SÓ para perguntar ao
 *                                            banco se nasceu lead; não é gravado.
 */
async function registrar(tenantId, p = {}) {
  if (!LIGADO || !tenantId || !p.cron) return;
  try {
    const cron = p.cron;
    const totalMs = cron.totalMs();
    const recebidoEmMs = cron.t0;
    const f = cron.fases || {};

    await withTenant(tenantId, async (c) => {
      // Nasceu lead NESTA mensagem? Casa pela régua da casa (br_phone_key, migr 085) — a mesma
      // de upsertConversation. Comparar "só os dígitos" era a alternativa óbvia e é a que já
      // cruzou grupo com privado neste projeto; não repetir.
      let existe = false, novo = false;
      const chave = String(p.identBruto || '');
      if (chave) {
        const r = await c.query(
          `SELECT count(*)::int AS n,
                  coalesce(bool_or(created_at >= $2), false) AS novo
             FROM leads
            WHERE br_phone_key(coalesce(phone, '')) <> ''
              AND br_phone_key(coalesce(phone, '')) = br_phone_key($1)`,
          [chave, new Date(recebidoEmMs)]
        );
        existe = (r.rows[0]?.n || 0) > 0;
        novo = r.rows[0]?.novo === true;
      }

      await c.query(
        `INSERT INTO ingestao_latencia
           (tenant_id, external_message_id, canal, recebido_em, enviado_em,
            fila_ms, origem_ms, midia_ms, funil_ms, total_ms,
            tem_midia, tipo_midia, lead_existe, lead_novo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          tenantId,
          p.externalMessageId || null,
          p.canal || 'whatsapp',
          new Date(recebidoEmMs),
          Number.isFinite(Number(p.messageTimestamp)) && Number(p.messageTimestamp) > 0
            ? new Date(Math.round(Number(p.messageTimestamp) * 1000)) : null,
          filaMs(p.messageTimestamp, recebidoEmMs),
          f.origem_ms ?? null,
          f.midia_ms ?? null,
          f.funil_ms ?? null,
          totalMs,
          !!p.tipoMidia,
          p.tipoMidia || null,
          existe,
          novo,
        ]
      );
    });
  } catch (e) {
    const causa = (e && (e.code || e.message)) ? String(e.code || e.message).slice(0, 80) : 'desconhecida';
    if (causa !== _ultimaFalha) {
      _ultimaFalha = causa;
      // Nível warn de propósito: a medição falhar não é incidente de produção, mas tabela vazia
      // não pode ser lida como "não chegou mensagem".
      logger.warn('latencia.nao_gravou', { tenant_id: tenantId, causa });
    }
  }
}

// --------------------------------------------------------------------------------------------
// LEITURA — puro, sem banco, para o script e para o teste.
// --------------------------------------------------------------------------------------------

// Percentil pelo método do "mais próximo pela ordem" (nearest-rank): p50 de 10 valores é o 5º.
// Sem interpolação de propósito: o número tem de ser um tempo que ALGUMA mensagem realmente
// levou, não uma média entre duas. Em medição de latência, inventar um valor intermediário é
// como dizer que a conversa durou 2,5 mensagens.
function percentil(valores, p) {
  const v = (valores || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const posicao = Math.ceil((p / 100) * v.length);
  return v[Math.min(Math.max(posicao, 1), v.length) - 1];
}

// Desvio de relógio: a fila só vale quando o resultado é plausível. Negativo = o WhatsApp diz que
// a mensagem foi enviada DEPOIS de nós a recebermos. Acima de 1h = relógio perdido ou backfill de
// histórico, não latência. Os dois casos saem da conta E são CONTADOS, para a leitura poder dizer
// "descartei N" em vez de esconder.
const FILA_MAX_MS = 60 * 60 * 1000;
const filaPlausivel = (ms) => Number.isFinite(ms) && ms >= 0 && ms <= FILA_MAX_MS;

/**
 * Resume as linhas da tabela em números que se defende. `linhas` = objetos com
 * { total_ms, funil_ms, midia_ms, fila_ms, lead_novo, tem_midia }.
 */
function resumir(linhas) {
  const todas = Array.isArray(linhas) ? linhas : [];
  const novos = todas.filter((l) => l.lead_novo === true);
  const filas = todas.map((l) => Number(l.fila_ms)).filter(filaPlausivel);
  const fatia = (conjunto, campo) => {
    const v = conjunto.map((l) => Number(l[campo]));
    return {
      n: v.filter(Number.isFinite).length,
      p50: percentil(v, 50), p90: percentil(v, 90), p95: percentil(v, 95),
      max: percentil(v, 100),
    };
  };
  return {
    mensagens: todas.length,
    leads_novos: novos.length,
    com_midia: todas.filter((l) => l.tem_midia === true).length,
    // ESTE é o número do "no instante": só as mensagens que viraram lead novo têm o que avisar.
    total_lead_novo: fatia(novos, 'total_ms'),
    funil_lead_novo: fatia(novos, 'funil_ms'),
    // Contexto: toda mensagem passa pelo funil, tenha virado lead ou não.
    total_todas: fatia(todas, 'total_ms'),
    midia_todas: fatia(todas.filter((l) => l.tem_midia === true), 'midia_ms'),
    fila: { ...fatia(filas.map((ms) => ({ fila_ms: ms })), 'fila_ms'),
            descartadas_por_relogio: todas.filter((l) => l.fila_ms != null).length - filas.length },
  };
}

module.exports = { iniciar, registrar, resumir, percentil, filaMs, filaPlausivel, LIGADO };
