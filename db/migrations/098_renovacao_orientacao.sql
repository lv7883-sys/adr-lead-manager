-- ============================================================
-- 098 — RENOVAÇÃO Fase C2: orientação da IA para os toques D-10 / D-2.
-- Texto livre em que o gestor descreve COMO a IA deve abordar a renovação (tom, foco, o que
-- oferecer/evitar). Alimenta os DOIS caminhos de geração: o sweep D-10/D-2 no Lead Manager
-- (gemini.sugestaoRenovacao) e a sugestão ao vivo do dashboard (qualidade-ia.sugerirRenovacao).
-- Editável só por gerente/admin na tela do gráfico (Gestão de Retenção → Renovações).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 098_renovacao_orientacao.sql
-- ============================================================

ALTER TABLE lead_manager.automacao_config ADD COLUMN IF NOT EXISTS renovacao_orientacao text;

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.automacao_config DROP COLUMN IF EXISTS renovacao_orientacao;
