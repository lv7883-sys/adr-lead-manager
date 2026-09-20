'use strict';
//
// fila.js — CADA UNIDADE TEM A SUA FILA; o rodízio é a ordem de atendimento.
//
// As tarefas de uma unidade são invisíveis para as outras (RLS) e nenhuma consegue
// adiantar, atrasar ou ver a fila da vizinha. O que é compartilhado é o TRABALHADOR que
// processa — como um atendente único no balcão. Se ele atendesse por ordem de chegada
// pura, a unidade que mandasse 500 peças de uma vez seguraria todas as outras por horas.
// Por isso ele ALTERNA: atende a fila que está esperando há mais tempo (ou que nunca foi
// atendida), pega uma tarefa, e passa para a próxima.
//
// `FOR UPDATE SKIP LOCKED`: vários trabalhadores podem rodar ao mesmo tempo sem pegar a
// mesma tarefa e sem um segurar o outro.
//
// TRÊS PORTÕES antes de processar, nesta ordem:
//   1. contratação — a unidade contratou o módulo? (plataforma.modulo_contratado)
//   2. cota        — ainda cabe no plano dela? (plataforma.consumo_evento × cota)
//   3. trava       — a tarefa é minha? (SKIP LOCKED)
// Estourou a cota, a tarefa vira 'cota_excedida' com o motivo escrito. Nunca some em
// silêncio: fila que para sem dizer por quê é a pior forma de falhar num produto pago.
//
const { pool, withTenant } = require('../db');
const logger = require('../logger');
const licenca = require('../plataforma/licenca');
const consumo = require('../plataforma/consumo');

const MODULO = 'MARKETING';

// Cota -> o que ela limita. 'tarefas_mes' conta tarefas atendidas no mês; o resto casa com
// os tipos medidos em plataforma.consumo_evento.
const COTAS = Object.freeze({
  tarefas_mes: 'tarefas',
  ia_visao_mes: consumo.TIPOS.IA_VISAO,
  ia_texto_mes: consumo.TIPOS.IA_TEXTO,
  transcricao_seg_mes: consumo.TIPOS.TRANSCRICAO_SEG,
  video_seg_mes: consumo.TIPOS.VIDEO_SEG,
  storage_gb_dia: consumo.TIPOS.STORAGE_GB_DIA,
});

/**
 * PURO (testável): a unidade estourou alguma cota do plano?
 * @param {object} cota  ex.: { tarefas_mes: 100, ia_visao_mes: 500 }
 * @param {object} uso   ex.: { tarefas: 100, ia_visao: 12 }
 * @returns {?{cota: string, limite: number, usado: number}}  null = ainda cabe
 */
function _excedeCota(cota, uso) {
  if (!cota || typeof cota !== 'object') return null;
  for (const [chave, tipo] of Object.entries(COTAS)) {
    const limite = cota[chave];
    if (limite == null) continue;                       // cota ausente = sem limite
    const lim = Number(limite);
    if (!Number.isFinite(lim)) continue;
    const usado = Number((uso && uso[tipo]) || 0);
    if (usado >= lim) return { cota: chave, limite: lim, usado };
  }
  return null;
}

/**
 * PURO (testável): ordem de atendimento das filas. Quem nunca foi atendida vem primeiro;
 * depois, a que foi atendida há mais tempo. Empate desempata pelo id, para ser determinístico.
 */
function _ordemRodizio(linhas) {
  const t = (v) => (v == null ? -Infinity : new Date(v).getTime());
  return [...(linhas || [])].sort((a, b) => {
    const d = t(a.ultima_vez) - t(b.ultima_vez);
    return d !== 0 ? d : String(a.tenant_id).localeCompare(String(b.tenant_id));
  });
}

/** Põe uma tarefa na fila da unidade. Sem contratação vigente, nem entra. */
async function enfileirar(tenantId, tipo, dados = {}, { prioridade = 0 } = {}) {
  await licenca.garantirModulo(tenantId, MODULO);
  return withTenant(tenantId, async (c) => (await c.query(
    `INSERT INTO marketing.tarefa (tenant_id, tipo, dados, prioridade)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING id, situacao, criado_em`,
    [tenantId, String(tipo), JSON.stringify(dados || {}), prioridade])).rows[0]);
}

/**
 * Filas que estão esperando, já na ordem do rodízio. Pergunta da PLATAFORMA: sai do contexto
 * de unidade e usa a função SECURITY DEFINER, que devolve só id e contagem — nada de conteúdo.
 */
async function unidadesNaFila() {
  const { rows } = await pool.query('SELECT tenant_id, pendentes, ultima_vez FROM marketing.unidades_com_fila()');
  return _ordemRodizio(rows);
}

/**
 * Cota da unidade. Vem de `marketing.config_unidade.cota` — que é LIMITE DE USO, não
 * contratação: quem diz se a unidade contratou é `licenca.garantirModulo` (ponto único).
 * Sem linha de configuração = sem limite.
 */
async function _cotaDaUnidade(client, tenantId) {
  const r = await client.query(
    'SELECT cota FROM marketing.config_unidade WHERE tenant_id = $1', [tenantId]);
  return (r.rows[0] && r.rows[0].cota) || {};
}

/** Uso do mês desta unidade (consumo medido + tarefas atendidas), para a checagem de cota. */
async function _usoDoMes(tenantId, client) {
  const uso = await consumo.consumoDoMes(tenantId, MODULO, { client });
  const r = await client.query(
    `SELECT count(*)::int AS n FROM marketing.tarefa
      WHERE tenant_id = $1 AND pega_em >= date_trunc('month', now())`,
    [tenantId]);
  uso.tarefas = r.rows[0] ? r.rows[0].n : 0;
  return uso;
}

/**
 * Pega a próxima tarefa respeitando contratação, cota e rodízio.
 * @returns {Promise<?object>} a tarefa pega, ou null se não havia nada para fazer.
 */
async function pegarTarefa({ trabalhador = `t-${process.pid}`, maxUnidades = 50 } = {}) {
  const unidades = await unidadesNaFila();
  for (const u of unidades.slice(0, maxUnidades)) {
    const tenantId = u.tenant_id;

    // Portão 1 — contratação. Sem módulo vigente, a fila daquela unidade nem é olhada.
    // Vale também para a suspensão que aconteceu DEPOIS de a tarefa entrar na fila.
    try {
      await licenca.garantirModulo(tenantId, MODULO);
    } catch (e) {
      logger.info('fila.sem_contratacao', { tenant_id: tenantId, motivo: e.motivo || e.message });
      continue;
    }

    const resultado = await withTenant(tenantId, async (c) => {
      // Portão 2 — cota. A cota de uma unidade nunca consome a da outra: tudo aqui é
      // contado dentro do contexto dela, sob RLS.
      const uso = await _usoDoMes(tenantId, c);
      const estouro = _excedeCota(await _cotaDaUnidade(c, tenantId), uso);
      if (estouro) {
        const r = await c.query(
          `UPDATE marketing.tarefa
              SET situacao = 'cota_excedida',
                  motivo_cota = $2,
                  concluido_em = now()
            WHERE tenant_id = $1 AND situacao = 'pendente'`,
          [tenantId, `${estouro.cota}: ${estouro.usado}/${estouro.limite}`]);
        return { cota: estouro, marcadas: r.rowCount };
      }

      // Portão 3 — a trava. SKIP LOCKED: se outro trabalhador já pegou esta tarefa,
      // seguimos adiante em vez de esperar.
      const alvo = await c.query(
        `SELECT id FROM marketing.tarefa
          WHERE tenant_id = $1 AND situacao = 'pendente'
          ORDER BY prioridade DESC, criado_em
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [tenantId]);
      if (!alvo.rows[0]) return null;
      const tarefa = await c.query(
        `UPDATE marketing.tarefa
            SET situacao = 'processando', pega_em = now(), tentativas = tentativas + 1, trabalhador = $3
          WHERE id = $2 AND tenant_id = $1
          RETURNING id, tenant_id, tipo, dados, prioridade, tentativas, criado_em, pega_em`,
        [tenantId, alvo.rows[0].id, trabalhador]);
      return { tarefa: tarefa.rows[0] };
    });

    if (!resultado) continue;                       // a fila da unidade esvaziou na corrida
    if (resultado.cota) {
      logger.warn('fila.cota_estourada', {
        tenant_id: tenantId, cota: resultado.cota.cota,
        limite: resultado.cota.limite, usado: resultado.cota.usado, tarefas_marcadas: resultado.marcadas,
      });
      continue;                                     // próxima fila — uma cota estourada não para as outras
    }
    logger.info('fila.pegou', { tenant_id: tenantId, tarefa_id: resultado.tarefa.id, tipo: resultado.tarefa.tipo });
    return resultado.tarefa;
  }
  return null;
}

/** Encerra com sucesso. */
async function concluir(tenantId, tarefaId) {
  return withTenant(tenantId, async (c) => (await c.query(
    `UPDATE marketing.tarefa SET situacao = 'concluida', concluido_em = now(), erro = NULL
      WHERE tenant_id = $1 AND id = $2 AND situacao = 'processando' RETURNING id`,
    [tenantId, tarefaId])).rowCount);
}

/** Encerra com falha (ou devolve para a fila, se ainda há tentativa). */
async function falhar(tenantId, tarefaId, erro, { devolver = false } = {}) {
  return withTenant(tenantId, async (c) => (await c.query(
    `UPDATE marketing.tarefa
        SET situacao = $3, erro = $4, concluido_em = CASE WHEN $3 = 'falhou' THEN now() END
      WHERE tenant_id = $1 AND id = $2 RETURNING id`,
    [tenantId, tarefaId, devolver ? 'pendente' : 'falhou', String(erro || '').slice(0, 2000)])).rowCount);
}

module.exports = {
  enfileirar, pegarTarefa, concluir, falhar, unidadesNaFila,
  MODULO, COTAS, _excedeCota, _ordemRodizio,
};
