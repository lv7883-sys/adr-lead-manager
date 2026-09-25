'use strict';
//
// interesses.js — POPULA lead_interesse a partir das fichas da Extranet (passo 1, migr 180/181).
//
// ⚠ RODA FORA DO PIPELINE, DE PROPÓSITO. Regra do Leo (25/09): "a identificação de leads já
// funciona muito bem, com o gate, IA, etc. e isso não pode em hipótese nenhuma se perder. O que
// vamos fazer é uma melhoria ON TOP do que já temos." Se este código vivesse dentro do
// syncExtranetLeads, o pipeline mudaria — e a prova de que nada se mexeu deixaria de existir.
// Por isso: módulo próprio, chamado por job próprio, e `sync-extranet-leads.js` fica byte-a-byte
// igual. Nada aqui escreve em `leads`, `lead_eventos` ou `stage_autoapply_log`.
//
// O QUE A FICHA DA EXTRANET DÁ, E O QUE NÃO DÁ
//   DÁ:    quem PROCUROU (nome do contato) e o CURSO. Uma ficha por interesse — a Simone Bassi
//          Armani tem duas (Canto realizada + Piano cancelada), que hoje viram UM card só.
//   NÃO DÁ: para QUEM é o interesse. A ficha "Cristiane Angelino Xavier / Piano" é de quem
//          matriculou o Bernardo (filho). O beneficiário está na conversa, não na ficha.
//   Logo: `para_si` fica NULL (= ninguém disse ainda). Ver migr 181 — converter NULL em `true`
//   por conveniência funde duas pessoas numa só, e o erro é invisível.
//
// COBERTURA HONESTA (medida 25/09): a Extranet cobre 184 dos 748 leads (25%). O WhatsApp é a
// fonte principal e não tem ficha por interesse — lá o "para quem" e o segundo instrumento só
// existem no texto da conversa. Este populamento é o quarto do problema que dá para resolver sem
// tocar em IA nenhuma; os outros três quartos são trabalho seguinte.
//
// IDEMPOTENTE: uma ficha = um interesse (UNIQUE tenant_id+extranet_lead_id). Re-rodar atualiza
// `ultimo_visto_em` e o curso, nunca duplica. Ficha soft-deletada (fonte_ausente_em) é ignorada
// na criação, mas o interesse já criado NÃO é apagado — o interesse existiu de verdade.
//
const { withTenant } = require('../db');
const logger = require('../logger');

// Cria/atualiza um interesse por ficha PRESENTE e já ligada a um lead. Não toca em nada mais.
async function popularDaExtranet(c, { tenantId } = {}) {
  const r = await c.query(
    `INSERT INTO lead_manager.lead_interesse
       (tenant_id, lead_id, para_si, beneficiario_nome, curso, fonte, extranet_lead_id,
        primeiro_visto_em, ultimo_visto_em)
     SELECT e.tenant_id, e.lead_id,
            NULL, NULL,                      -- "para quem" não vem da ficha (migr 181)
            NULLIF(btrim(coalesce(e.curso, '')), ''),
            'extranet_lead', e.id,
            COALESCE(e.data_cadastro, e.first_seen_at), e.last_seen_at
       FROM lead_manager.extranet_lead e
      WHERE e.tenant_id = $1 AND e.lead_id IS NOT NULL AND e.fonte_ausente_em IS NULL
     ON CONFLICT (tenant_id, extranet_lead_id) DO UPDATE
        SET curso = EXCLUDED.curso,
            ultimo_visto_em = EXCLUDED.ultimo_visto_em,
            updated_at = now()
      RETURNING (xmax = 0) AS inserido`,
    [tenantId]);
  const novos = r.rows.filter((x) => x.inserido).length;
  return { novos, atualizados: r.rowCount - novos, total: r.rowCount };
}

// Resumo para conferência: quantos leads passaram a ter MAIS DE UM interesse — é o ganho que o
// modelo antigo não conseguia representar (um lead, um interesse).
async function resumo(c, { tenantId } = {}) {
  const q = await c.query(
    `SELECT count(*)::int AS interesses,
            count(DISTINCT lead_id)::int AS leads,
            count(*) FILTER (WHERE curso IS NULL)::int AS sem_curso,
            count(*) FILTER (WHERE para_si IS NULL)::int AS para_quem_desconhecido
       FROM lead_manager.lead_interesse WHERE tenant_id = $1`, [tenantId]);
  const multi = await c.query(
    `SELECT count(*)::int AS n FROM (
       SELECT lead_id FROM lead_manager.lead_interesse
        WHERE tenant_id = $1 GROUP BY lead_id HAVING count(*) > 1) t`, [tenantId]);
  return { ...q.rows[0], leads_com_mais_de_um_interesse: multi.rows[0].n };
}

async function run(tenantId) {
  const out = await withTenant(tenantId, async (c) => {
    const pop = await popularDaExtranet(c, { tenantId });
    return { ...pop, ...(await resumo(c, { tenantId })) };
  });
  logger.info('interesses.populados', { tenant_id: tenantId, ...out });
  return out;
}

module.exports = { popularDaExtranet, resumo, run };

if (require.main === module) {
  const tid = process.argv[2];
  if (!tid) { console.error('uso: node src/cadastro/interesses.js <tenantId>'); process.exit(1); }
  run(tid).then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(0); })
          .catch((e) => { console.error(e.message); process.exit(1); });
}
