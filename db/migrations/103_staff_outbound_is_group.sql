-- ============================================================
-- 103 — staff_outbound_samples.is_group: marcador BARATO de "saída para GRUPO".
--
-- POR QUE: a lista da Caixa de Entrada (ADR-042, src/routes/inbox.js) precisa só da ÚLTIMA
-- saída da recepção por telefone, mas para excluir mensagens de GRUPO (o operador às vezes
-- digita em grupos @g.us) ela abria o JSON `raw` de CADA uma das ~60k linhas
-- (coalesce(raw->'data'->'key'->>'remoteJid','') NOT LIKE '%@g.us') → parse de JSON por linha,
-- ~560ms só no scan. Materializando esse teste numa coluna booleana, o filtro fica trivial e
-- a lista pega a última saída por ident VIA ÍNDICE, sem varrer tudo nem tocar `raw`.
--
-- SEMÂNTICA IDÊNTICA: `raw` só é não-nulo nas saídas digitadas no APARELHO (eco fromMe,
-- staffSamples.js). Saídas da API/dashboard têm raw NULL (nunca vão p/ grupo) e o backfill as
-- deixa is_group=false — exatamente o que o filtro antigo já fazia (coalesce('') → incluída).
-- O insert do eco (staffSamples.js) passa a gravar is_group a partir do remoteJid.
--
-- SEM UPDATE em runtime: o GRANT da 010 não dá UPDATE ao lead_manager_user. O backfill abaixo
-- roda como postgres (superuser) na aplicação da migração. is_group é decidido no INSERT.
--
-- Migrations manuais, sem runner (NUNCA db push):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 103_staff_outbound_is_group.sql
--
-- EM PRODUÇÃO (tabela grande + tela ao vivo): rodar a coluna e o backfill por esta migração,
-- mas criar o ÍNDICE com CREATE INDEX CONCURRENTLY NA MÃO (fora de transação, sem lock na
-- lista) — o IF NOT EXISTS aqui vira no-op lá; em banco novo/restore, esta migração o recria.
-- ============================================================

-- Metadados-only no PG11+ (default constante) → instantâneo, sem rewrite da tabela.
ALTER TABLE lead_manager.staff_outbound_samples
  ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false;

-- Backfill: marca as saídas de GRUPO existentes (só as com raw cru do eco têm remoteJid).
UPDATE lead_manager.staff_outbound_samples
   SET is_group = true
 WHERE is_group = false
   AND raw->'data'->'key'->>'remoteJid' LIKE '%@g.us';

-- Índice parcial que casa a lista: por ident (dígitos) + received_at DESC, só NÃO-grupo.
-- Dá a ordem do DISTINCT ON (última saída por telefone) sem sort e sem varrer as de grupo.
CREATE INDEX IF NOT EXISTS idx_staff_notgroup_ident_recv
  ON lead_manager.staff_outbound_samples
     (tenant_id, regexp_replace(external_id, '[^0-9]', '', 'g'), received_at DESC)
  WHERE NOT is_group;

-- ROLLBACK (manual):
--   DROP INDEX IF EXISTS lead_manager.idx_staff_notgroup_ident_recv;
--   ALTER TABLE lead_manager.staff_outbound_samples DROP COLUMN IF EXISTS is_group;
