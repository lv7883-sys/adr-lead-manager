-- ============================================================
-- 099 — RENOVAÇÃO Fase D1: resolução POR CONTRATO (não mais 1 por telefone).
-- A recepção marca a situação (renovou / não vai renovar) de CADA contrato na tela do gráfico.
-- Uma pessoa pode ter vários contratos vencendo (ex.: piano + canto), cada um com seu vencimento.
-- A PK antiga (tenant_id, br_key) só deixava 1 linha por telefone → marcar o 2º contrato apagava o 1º.
-- Trocamos por um índice único (tenant_id, br_key, venc) — permite 1 linha por CICLO de vencimento.
-- venc pode ser NULL (conversa sem contrato, resolvida pelo inbox) → sentinela na chave para caber.
-- Tabela hoje VAZIA em prod → troca segura, sem migração de dados.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 099_renovacao_dismiss_por_contrato.sql
-- ============================================================

ALTER TABLE lead_manager.renovacao_dismiss DROP CONSTRAINT IF EXISTS renovacao_dismiss_pkey;

CREATE UNIQUE INDEX IF NOT EXISTS renovacao_dismiss_ciclo_uk
  ON lead_manager.renovacao_dismiss (tenant_id, br_key, COALESCE(venc, '1900-01-01'::date));

-- ROLLBACK (manual):
--   DROP INDEX IF EXISTS lead_manager.renovacao_dismiss_ciclo_uk;
--   ALTER TABLE lead_manager.renovacao_dismiss ADD PRIMARY KEY (tenant_id, br_key);
