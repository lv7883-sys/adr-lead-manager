'use strict';
//
// expansaoCurso.js — LISTA DE OPORTUNIDADES DE SEGUNDO CURSO (decisão do Leo, 23/09/2026).
//
// O PROBLEMA: o LM trabalha por PESSOA (telefone único por lead, migr 004) e a Extranet trabalha
// por FICHA (uma por curso). Aluno que já matriculou violão e abre ficha de canto vira UM card, e
// a régua não o toca (desfecho é intocável) — o interesse novo SOME do funil. A spec de jun/2026
// (spec-contato-oportunidade.md §3) já previa "1 contato → N oportunidades", nunca implementado.
//
// A DECISÃO (caminho curto, explicitamente escolhido pelo Leo em 23/09): NÃO virar card no funil
// nem entrar na taxa de conversão — o modelo pessoa×oportunidade fica fora de escopo, e nada de
// mexer no índice único de telefone nem no da origem_lead. Em vez disso, uma LISTA de trabalho:
// quem já é aluno e tem ficha ATIVA de outro curso aparece para a recepção vender.
//
// SEM ESTADO, DE PROPÓSITO: é consulta DERIVADA, não tabela. Não há o que sincronizar, não há
// linha velha para limpar, e a lista está sempre certa — se a recepção fechar a venda (a ficha
// vira 'Ganhou') ou a pessoa desistir, o caso sai sozinho no próximo carregamento. É a lição das
// três armadilhas de 22-23/09: número derivado de estado paralelo diverge; medir direto, não.
//
// RÉGUA (duas provas, ambas da Extranet, sem fuzzy de nome):
//   É ALUNO   — o lead tem desfecho 'matriculado'/'cliente' (o contractConvert já decidiu isso
//               por CONTRATO, migr 079) OU tem ficha com situação de matrícula ('Ganhou').
//   QUER MAIS — tem OUTRA ficha presente cuja situação mapeia para etapa de trabalho
//               (Conexão/Atendido/Exp. Agendada/Exp. Realizada — as mirror-only ficam de fora:
//               'Exp. Cancelada'/'Perdeu'/'Stand By' não são interesse ativo).
//   CURSO DIFERENTE — quando os dois cursos são conhecidos, precisam diferir; se a ficha ativa
//               não informa curso (a Extranet aceita ficha sem curso), ENTRA mesmo assim e o
//               curso vai como null: melhor a recepção olhar e descartar do que perder a venda.
//
const { SITUACAO_MAP } = require('./extranetLeadStage');

// Situações (já normalizadas) que provam interesse ATIVO e que provam MATRÍCULA, derivadas da
// fonte única do mapa — não reescrever a lista à mão, senão diverge quando o mapa mudar.
const _norm = Object.entries(SITUACAO_MAP);
const ATIVAS = _norm.filter(([, v]) => v && v !== 'convertido').map(([k]) => k);
const MATRICULA = _norm.filter(([, v]) => v === 'convertido').map(([k]) => k);

// Normalização da situação em SQL, espelhando extranetLeadStage.normSituacao (minúscula, sem
// acento, sem pontuação, espaços colapsados). unaccent não é garantido no banco → translate.
const _sitNorm = (col) => `btrim(regexp_replace(
  lower(translate(${col}, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')),
  '[^a-z0-9 ]+', ' ', 'g'), ' ')`;

// Lista as oportunidades de expansão do tenant. Uma linha por (lead × ficha ativa) — a mesma
// pessoa pode querer DOIS cursos novos, e cada um é uma linha de trabalho.
async function listarExpansoes(c, { tenantId, limit = 200 } = {}) {
  const sql = `
    WITH fichas AS (
      SELECT e.lead_id, e.id AS ficha_id, e.extranet_id, e.curso, e.situacao, e.professor,
             e.exp_agendada_em, e.exp_realizada_em, e.data_cadastro, e.ult_contato, e.prox_contato,
             ${_sitNorm('e.situacao')} AS sit
        FROM lead_manager.extranet_lead e
       WHERE e.tenant_id = $1 AND e.lead_id IS NOT NULL AND e.fonte_ausente_em IS NULL
    ),
    aluno AS (   -- cursos que a pessoa JÁ tem (por ficha de matrícula)
      SELECT lead_id, array_agg(DISTINCT curso) FILTER (WHERE curso IS NOT NULL AND curso <> '') AS cursos
        FROM fichas WHERE sit = ANY($2::text[]) GROUP BY lead_id
    )
    SELECT l.id::text AS lead_id, l.name, l.phone, l.desfecho,
           f.extranet_id, f.curso AS curso_novo, f.situacao, f.professor,
           a.cursos AS cursos_atuais,
           f.data_cadastro, f.ult_contato, f.prox_contato
      FROM fichas f
      JOIN lead_manager.leads l ON l.id = f.lead_id
      LEFT JOIN aluno a ON a.lead_id = f.lead_id
     WHERE f.sit = ANY($3::text[])                                  -- ficha com interesse ATIVO
       AND (l.desfecho IN ('matriculado', 'cliente') OR a.lead_id IS NOT NULL)   -- é aluno
       AND (f.curso IS NULL OR f.curso = '' OR a.cursos IS NULL OR NOT (f.curso = ANY(a.cursos)))
     ORDER BY COALESCE(f.data_cadastro, now()) DESC
     LIMIT $4`;
  const r = await c.query(sql, [tenantId, MATRICULA, ATIVAS, limit]);
  return r.rows;
}

// Só o total (para o card do Plantão). Degrada elegante: erro → null, nunca derruba o card.
async function contarExpansoes(c, { tenantId } = {}) {
  try {
    const rows = await listarExpansoes(c, { tenantId, limit: 1000 });
    return rows.length;
  } catch { return null; }
}

module.exports = { listarExpansoes, contarExpansoes, ATIVAS, MATRICULA };
