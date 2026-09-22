'use strict';
//
// consumo.js — QUANTO CADA UNIDADE GASTOU.
//
// Um módulo com custo variável (visão, texto, transcrição, vídeo, storage) sem medição por
// unidade é um módulo que não se pode vender: no fim do mês existe uma fatura do provedor e
// nenhuma forma honesta de dividi-la. A medição nasce junto com o motor, não depois.
//
// Esta é a INTERFACE de medição. Nenhuma lógica de IA aqui — quem chamar a IA chama
// registrarUso() logo depois, com a quantidade real (tokens, segundos, GB-dia).
//
const { withTenant } = require('../db');
const logger = require('../logger');

// Tipos medidos. Lista fechada de propósito: tipo novo entra aqui e na cota, junto —
// senão aparece consumo que nenhuma cota limita.
const TIPOS = Object.freeze({
  IA_VISAO: 'ia_visao',                  // 1 chamada de visão
  IA_TEXTO: 'ia_texto',                  // 1 chamada de texto
  TRANSCRICAO_SEG: 'transcricao_seg',    // segundos de áudio transcrito
  VIDEO_SEG: 'video_seg',                // segundos de vídeo processado
  STORAGE_GB_DIA: 'storage_gb_dia',      // GB-dia de armazenamento
  MIDIA_INGERIDA: 'midia_ingerida',      // 1 arquivo entrando pela ingestão do grupo
});
const TIPOS_VALIDOS = new Set(Object.values(TIPOS));

// Custo unitário padrão em BRL. É PONTO DE PARTIDA: o preço real vem de quem chama
// (o provedor muda preço, e o histórico não pode ser reescrito por isso — por isso o
// custo é gravado NA LINHA, congelado no momento do consumo).
const CUSTO_PADRAO_BRL = Object.freeze({
  [TIPOS.IA_VISAO]: 0.02,
  [TIPOS.IA_TEXTO]: 0.005,
  [TIPOS.TRANSCRICAO_SEG]: 0.0006,
  [TIPOS.VIDEO_SEG]: 0.004,
  [TIPOS.STORAGE_GB_DIA]: 0.0008,
  // Ingestão em si não chama provedor: o custo é o armazenamento do arquivo até a
  // curadoria decidir. Valor simbólico — o que importa aqui é CONTAR, para a cota existir.
  [TIPOS.MIDIA_INGERIDA]: 0.0005,
});

/**
 * Registra consumo. Best-effort: medição NUNCA derruba o trabalho que já foi feito
 * (a chamada de IA já custou — perder o registro é ruim, perder o resultado é pior).
 * Retorna true se gravou.
 */
async function registrarUso(tenantId, moduleCode, eventType, quantidade = 1, opcoes = {}) {
  if (!tenantId || !moduleCode) return false;
  if (!TIPOS_VALIDOS.has(eventType)) {
    logger.warn('consumo.tipo_desconhecido', { tenant_id: tenantId, tipo_evento: eventType });
    return false;
  }
  const qtd = Number(quantidade);
  if (!Number.isFinite(qtd) || qtd < 0) return false;
  const custo = opcoes.custoUnitario != null ? Number(opcoes.custoUnitario) : (CUSTO_PADRAO_BRL[eventType] || 0);
  try {
    const exec = opcoes.client
      ? opcoes.client.query.bind(opcoes.client)
      : (sql, params) => withTenant(tenantId, (c) => c.query(sql, params));
    await exec(
      `INSERT INTO plataforma.consumo_evento (tenant_id, modulo_codigo, tipo_evento, quantidade, custo_unitario_brl, referencia)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, moduleCode, eventType, qtd, custo, opcoes.ref || null]);
    return true;
  } catch (e) {
    logger.error('consumo.falhou', { tenant_id: tenantId, module: moduleCode, tipo_evento: eventType, error: e.message });
    return false;
  }
}

/**
 * Consumo do mês corrente por tipo, para a checagem de cota. Chave do retorno = tipo.
 * Aceita um client já dentro de transação (a fila usa, para checar cota e pegar a tarefa
 * o job no mesmo contexto).
 */
async function consumoDoMes(tenantId, moduleCode, { client = null, referencia = null } = {}) {
  const sql =
    `SELECT tipo_evento, sum(quantidade) AS total
       FROM plataforma.consumo_evento
      WHERE tenant_id = $1 AND modulo_codigo = $2
        AND ocorrido_em >= date_trunc('month', COALESCE($3::timestamptz, now()))
        AND ocorrido_em <  date_trunc('month', COALESCE($3::timestamptz, now())) + interval '1 month'
      GROUP BY tipo_evento`;
  const params = [tenantId, moduleCode, referencia];
  const rows = client
    ? (await client.query(sql, params)).rows
    : await withTenant(tenantId, async (c) => (await c.query(sql, params)).rows);
  const out = {};
  for (const r of rows) out[r.tipo_evento] = Number(r.total);
  return out;
}

/** Custo da unidade por mês (lê a view; a RLS continua valendo). */
async function custoPorMes(tenantId, { meses = 6 } = {}) {
  return withTenant(tenantId, async (c) => (await c.query(
    `SELECT competencia, modulo_codigo, tipo_evento, quantidade, custo_brl, eventos
       FROM plataforma.vw_custo_unidade_mes
      WHERE competencia >= (date_trunc('month', now()) - make_interval(months => $1::int))::date
      ORDER BY competencia DESC, modulo_codigo, tipo_evento`,
    [meses])).rows);
}

module.exports = { registrarUso, consumoDoMes, custoPorMes, TIPOS, TIPOS_VALIDOS, CUSTO_PADRAO_BRL };
