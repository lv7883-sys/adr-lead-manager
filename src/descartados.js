'use strict';
/**
 * descartados.js — a lista de DESCARTADOS (ADR-019, rede de resgate) numa consulta só.
 *
 * POR QUE ESTE ARQUIVO EXISTE (medido em produção, 26/09/2026)
 *   A tela de Leads demorava ~9 s para abrir, e 8,3 s eram SÓ esta lista. Medição por partes,
 *   sob ROLE + set_config (sem isso o plano mente — lição do incidente de perf de agosto):
 *
 *     colunas da tabela, sem subconsulta ............     3 ms
 *     bola (de quem é a vez de falar) ............... 6.700 ms   <- 80% do tempo
 *     primeira mensagem (data) ......................   560 ms
 *     primeira mensagem (corpo) .....................   600 ms
 *     canal .........................................   520 ms
 *
 *   A causa NÃO era índice faltando: os índices funcionais existem e são válidos. Era a FORMA da
 *   pergunta. Cada uma daquelas linhas era uma subconsulta CORRELACIONADA — o banco a repetia
 *   uma vez POR LEAD (312x). Pior: para `lastOut` o planner escolhe caminhar a tabela por data
 *   (idx_staff_samples_tenant) e parar no primeiro acerto. Isso é ótimo quando há acerto e
 *   péssimo quando não há — e um DESCARTADO normalmente não tem resposta da recepção, então ele
 *   varria as 70.548 linhas inteiras, 312 vezes.
 *
 *   Agravante: `bolaSql` INTERPOLA o texto das subconsultas (até 10 vezes no CASE). Medido, a
 *   bola custava ~2x a soma das suas duas partes.
 *
 * O QUE MUDOU: pergunta-se UMA vez para todos. Três CTEs agregam por telefone (ident) e o
 *   resultado entra por LEFT JOIN. O banco varre cada tabela uma vez em vez de 312.
 *     antes 8.017 ms -> depois 146 ms (55x), medido em produção, duas execuções cada.
 *
 * ⚠ A RESPOSTA NÃO MUDA — e isso foi PROVADO, não deduzido: 313 linhas x 16 colunas, mesma
 *   ordem, ZERO diferenças (paridade rodada contra a produção antes de trocar).
 *   test/descartados-paridade.itest.js congela a consulta ANTIGA como oráculo e repete essa
 *   comparação em cenário sintético, com os casos de borda. Se alguém mexer aqui e a resposta
 *   mudar, o teste aponta a coluna.
 *
 * ⚠ DIFERENÇA DE BORDA (a única, e é a favor): a versão antiga casava por ident mesmo quando o
 *   ident era VAZIO — um lead sem telefone nem psid casaria com qualquer conversa cujo id não
 *   tivesse dígito. Hoje isso não ocorre de fato (1 descartado sem telefone, 0 conversas sem
 *   dígito, e a paridade deu idêntica), mas era um cruzamento errado esperando para acontecer —
 *   mesma família do incidente da "conversa fantasma de grupo". Aqui o ident vazio é excluído
 *   do casamento de propósito.
 *
 * NÃO MEXE NA IDENTIFICAÇÃO DE LEAD: isto só LÊ. Gate, classificador e régua de etapa seguem
 *   intactos; o filtro de quem é descartado é o mesmo texto de antes.
 */
const { naoEhReacaoSql } = require('./reacao');
const { bolaSql } = require('./bola');

// telefone do LEAD, só dígitos — a chave de casamento em todas as CTEs abaixo
const IDENT_LEAD = "regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')";
// telefone da CONVERSA / da amostra de saída, pela mesma régua
const identDe = (col) => `regexp_replace(${col}, '[^0-9]', '', 'g')`;

// Descartados = CASA DE RESGATE: tudo fora do funil como NOT_LEAD que dá pra recuperar —
// descartado pela IA (review_result NULL) OU marcado "não é lead" pela recepção
// (confirmed_not_lead). Exclui desfecho (decisão de resultado). Texto idêntico ao de antes.
const FILTRO_DESCARTADO = `l.status = 'NOT_LEAD' AND l.desfecho IS NULL
     AND (l.review_result IS NULL OR l.review_result = 'confirmed_not_lead')`;

// Rede de resgate: NÃO truncar a ponto de esconder leads (invariante: todo NOT_LEAD não-terminal
// tem que aparecer em Descartados). Teto alto, alinhado ao /leads (1000), para nenhum lead virar
// "limbo" invisível em todas as telas.
// O `, l.id` é DESEMPATE, não mudança de critério: a data continua mandando sozinha. Sem ele, dois
// descartados com a MESMA data ficam em ordem indefinida e podem trocar de lugar a cada recarga da
// tela — o Postgres não promete estabilidade em empate. Descoberto pelo teste de paridade, que
// empatou as datas de propósito. Não perde nem esconde ninguém: só para a lista de dançar.
const ORDEM = `ORDER BY coalesce(l.review_em, l.created_at) DESC NULLS LAST, l.id`;

const DESCARTADOS_SQL = `
WITH alvo AS (
  -- os leads da tela, JÁ ordenados e limitados: as CTEs abaixo só trabalham para estes
  SELECT l.*, ${IDENT_LEAD} AS ident
    FROM leads l
   WHERE ${FILTRO_DESCARTADO}
   ${ORDEM} LIMIT 1000
),
ids AS (
  -- ident vazio fica FORA do casamento de propósito (ver o aviso no topo do arquivo)
  SELECT DISTINCT ident FROM alvo WHERE ident <> ''
),
saida AS (
  -- última vez que a recepção falou com cada telefone (uma varredura, não uma por lead)
  SELECT ${identDe('s.external_id')} AS ident, max(s.received_at) AS last_out
    FROM staff_outbound_samples s
   WHERE s.tenant_id = $1 AND ${identDe('s.external_id')} IN (SELECT ident FROM ids)
   GROUP BY 1
),
entrada AS (
  -- numa varredura: último TURNO do cliente (reação não é turno), data e corpo da 1ª mensagem.
  -- DISTINCT ON + ORDER BY received_at ASC = a primeira mensagem; as janelas trazem os agregados
  -- do telefone inteiro junto, sem uma segunda passada.
  SELECT DISTINCT ON (ident) ident, last_in_turno, primeira_em, primeiro_corpo
    FROM (
      SELECT ${identDe('cv.external_id')} AS ident, m.received_at,
             m.body AS primeiro_corpo,
             max(m.received_at) FILTER (WHERE ${naoEhReacaoSql('m')})
               OVER (PARTITION BY ${identDe('cv.external_id')}) AS last_in_turno,
             min(m.received_at) OVER (PARTITION BY ${identDe('cv.external_id')}) AS primeira_em
        FROM messages m
        JOIN conversations cv ON cv.id = m.conversation_id
       WHERE cv.tenant_id = $1 AND m.role = 'USER'
         AND ${identDe('cv.external_id')} IN (SELECT ident FROM ids)
    ) z
   ORDER BY ident, received_at ASC
),
canal AS (
  -- canal da conversa mais recente daquele telefone
  SELECT DISTINCT ON (ident) ${identDe('cv.external_id')} AS ident, cv.channel
    FROM conversations cv
   WHERE cv.tenant_id = $1 AND ${identDe('cv.external_id')} IN (SELECT ident FROM ids)
   ORDER BY 1, cv.updated_at DESC
)
SELECT 'lead' AS kind, l.id::text AS id, coalesce(l.phone, l.meta_psid) AS phone, l.name,
       l.classification_confidence AS confidence, 'low_confidence' AS reason,
       l.classification_reasoning AS reasoning,
       -- intent não é gravado na coluna no caminho roteado (fica em classification_signals);
       -- p/ o chip "Candidato a vaga", surfaça CANDIDATO de lá quando a coluna estiver vazia.
       COALESCE(l.intent, CASE WHEN l.classification_signals->>0 = 'CANDIDATO' THEN 'CANDIDATO' END) AS intent,
       l.conversation_state, l.state_reasoning,
       -- BOLA DERIVADA (22/09/2026): a tela mostrava "ainda espera nossa resposta" lendo o
       -- conversation_state CRU, errado em 27 dos 28 leads ativos que ele marcava. Aqui vai a
       -- resposta JÁ descontada (src/bola.js). O campo cru continua no payload porque o Monitor
       -- da bola existe justamente para auditar o que a IA gravou.
       ${bolaSql({ lastInTurno: 'e.last_in_turno', lastOut: 'o.last_out' })} AS bola,
       CASE WHEN l.review_result = 'confirmed_not_lead' THEN 'recepcao' ELSE 'ia' END AS origem_descarte,
       coalesce(l.review_em, l.created_at) AS descartado_em,   -- ordenação 'mais_recente'
       e.primeira_em     AS received_at,
       e.primeiro_corpo  AS first_message,
       c.channel
  FROM alvo l
  LEFT JOIN saida   o ON o.ident = l.ident
  LEFT JOIN entrada e ON e.ident = l.ident
  LEFT JOIN canal   c ON c.ident = l.ident
 ${ORDEM}`;

/** Lista de descartados do tenant. `c` já vem no contexto do tenant (withTenant). */
async function fetchDescartados(c, tenantId) {
  return (await c.query(DESCARTADOS_SQL, [tenantId])).rows;
}

module.exports = { DESCARTADOS_SQL, fetchDescartados, FILTRO_DESCARTADO, IDENT_LEAD };
