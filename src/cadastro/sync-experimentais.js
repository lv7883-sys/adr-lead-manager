'use strict';
//
// sync-experimentais.js — SYNC CORE das aulas experimentais da agenda da Extranet (migr 129).
// Agnóstico de fonte: recebe o snapshot do adapter (valinhos-experimentais) e roda DENTRO de
// withTenant (RLS). Três passos:
//   1) REGISTRAR — upsert por (tenant_id, aula_id) do que a página MENSAL mostrou (id + rótulo).
//   2) DETALHAR  — grava o que a página de detalhe trouxe (aluno, telefones, status COM código…).
//   3) LIGAR     — aula sem lead_id casa lead por br_phone_key (a MESMA chave da fusão de conversas
//                  e do extranet_lead). NÃO cria lead: quem fez aula experimental sem nunca ter
//                  virado lead no Regente fica visível como "sem lead" — criar aqui mudaria a
//                  contagem de leads por um efeito colateral, e essa é uma decisão à parte.
//
// Idempotente: re-run do mesmo snapshot não muda nada.
//
// Status (código da Extranet). REALIZADA inclui 210/220/230: "sem matrícula", "com matrícula
// posterior" e "online" são todas aulas que aconteceram. Vêm da RÉGUA (stages.js) — o funil e este
// sync têm de concordar sobre o que é "realizada", então a lista existe num lugar só.
const { AULA_REALIZADA: REALIZADA, AULA_COM_MATRICULA: CONVERTIDA } = require('../stages');
const NAO_ACONTECEU = [300, 305, 310, 320];
const FUTURA = [0, 99, 100];

// 1) registra o que a página mensal mostrou. Não apaga ausentes: uma aula que some da grade (por
// edição de data, por exemplo) continua no espelho com o último estado conhecido.
async function registrarAulas(c, tenantId, aulas) {
  let tocadas = 0;
  for (const a of aulas || []) {
    const r = await c.query(
      `INSERT INTO lead_manager.aula_experimental (tenant_id, aula_id, competencia, rotulo_mes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, aula_id) DO UPDATE
         SET competencia = EXCLUDED.competencia, rotulo_mes = EXCLUDED.rotulo_mes, updated_at = now()
       WHERE lead_manager.aula_experimental.rotulo_mes  IS DISTINCT FROM EXCLUDED.rotulo_mes
          OR lead_manager.aula_experimental.competencia IS DISTINCT FROM EXCLUDED.competencia`,
      [tenantId, String(a.aulaId), a.competencia || null, a.rotulo || null]);
    tocadas += r.rowCount;
  }
  return tocadas;
}

// Quais aulas precisam (re)ler o detalhe: nunca lidas, ou cujo rótulo mensal mudou desde a última
// leitura — é assim que 'Realizada' vira 'Realizada com matrícula posterior' sem reabrir todas as
// aulas todo dia. Mais recentes primeiro: se o teto do adapter cortar, o que fica para depois é o
// mais antigo.
async function idsParaDetalhar(c, tenantId, ids) {
  if (!ids || !ids.length) return [];
  const r = await c.query(
    `SELECT aula_id FROM lead_manager.aula_experimental
      WHERE tenant_id = $1 AND aula_id = ANY($2)
        AND (detalhe_em IS NULL OR rotulo_mes IS DISTINCT FROM rotulo_mes_detalhado)
      ORDER BY competencia DESC NULLS LAST, aula_id DESC`,
    [tenantId, ids.map(String)]);
  return r.rows.map((x) => x.aula_id);
}

// 2) grava o detalhe. rotulo_mes_detalhado = o rótulo mensal vigente: marca "li o detalhe com a
// grade dizendo isto".
async function aplicarDetalhes(c, tenantId, detalhes) {
  let n = 0;
  for (const d of detalhes || []) {
    const r = await c.query(
      `UPDATE lead_manager.aula_experimental
          SET data = $3, status_cod = $4, status_rotulo = $5, aluno = $6, responsavel = $7,
              fone1_raw = $8, fone2_raw = $9, origem_extranet = $10, curso = $11, professor = $12,
              detalhe_em = now(), rotulo_mes_detalhado = rotulo_mes, updated_at = now()
        WHERE tenant_id = $1 AND aula_id = $2`,
      [tenantId, String(d.aulaId), d.data || null, d.statusCod, d.statusRotulo || null,
        d.aluno || null, d.responsavel || null, d.fone1 || null, d.fone2 || null,
        d.origem || null, d.curso || null, d.professor || null]);
    n += r.rowCount;
  }
  return n;
}

// 3) liga aula → lead pelo telefone. ⚠ br_phone_key devolve '' (não NULL) para telefone vazio —
// sem o `<> ''` todo mundo sem telefone casaria com todo mundo. Se o mesmo telefone tiver mais de
// um lead, fica o MAIS ANTIGO (first-touch: a aula pertence à primeira vez que a pessoa chegou).
// Só preenche quem está sem lead: ligação feita não é refeita, para o número de um mês fechado não
// mudar porque alguém mandou mensagem de outro aparelho depois.
async function ligarLeads(c, tenantId) {
  const r = await c.query(
    `UPDATE lead_manager.aula_experimental a
        SET lead_id = x.lead_id, updated_at = now()
       FROM (
         SELECT a2.id,
                (SELECT l.id FROM lead_manager.leads l
                  WHERE l.tenant_id = a2.tenant_id AND l.phone IS NOT NULL
                    AND lead_manager.br_phone_key(l.phone) <> ''
                    AND lead_manager.br_phone_key(l.phone) IN (NULLIF(a2.phone_key, ''), NULLIF(a2.phone_key2, ''))
                  ORDER BY l.created_at ASC LIMIT 1) AS lead_id
           FROM lead_manager.aula_experimental a2
          WHERE a2.tenant_id = $1 AND a2.lead_id IS NULL
            AND (a2.phone_key <> '' OR a2.phone_key2 <> '')
       ) x
      WHERE a.id = x.id AND x.lead_id IS NOT NULL`,
    [tenantId]);
  return r.rowCount;
}

// Retrato do espelho, para o log de cada execução.
async function resumo(c, tenantId) {
  const r = await c.query(
    `SELECT count(*)::int AS aulas,
            count(*) FILTER (WHERE detalhe_em IS NOT NULL)::int AS detalhadas,
            count(*) FILTER (WHERE lead_id IS NOT NULL)::int AS ligadas,
            count(*) FILTER (WHERE detalhe_em IS NOT NULL AND lead_id IS NULL)::int AS sem_lead,
            count(*) FILTER (WHERE status_cod = ANY($2))::int AS realizadas
       FROM lead_manager.aula_experimental WHERE tenant_id = $1`,
    [tenantId, REALIZADA]);
  return r.rows[0];
}

module.exports = {
  registrarAulas, idsParaDetalhar, aplicarDetalhes, ligarLeads, resumo,
  REALIZADA, CONVERTIDA, NAO_ACONTECEU, FUTURA,
};
