-- ============================================================
-- E4: credenciais Evolution por tenant. O Lead Manager passa a ENVIAR direto via
-- Evolution API (src/evolution.js, porta do evolution.js do Scheduler), independente
-- do Scheduler. RODAR COMO SUPERUSER postgres (lead_manager.tenants é owned by postgres).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 014_tenant_evolution_credentials.sql
-- ============================================================

-- evolution_instance  : nome da instância Evolution do tenant (texto claro).
-- evolution_token_enc : token da instância, CRIPTOGRAFADO com a LM_ENCRYPTION_KEY
--                       (src/crypto.js — chave própria do LM, distinta do Scheduler).
-- lead_manager_user já tem GRANT table-level (SELECT/UPDATE) em tenants, que cobre
-- colunas futuras — nenhum GRANT adicional é necessário.
ALTER TABLE lead_manager.tenants
    ADD COLUMN IF NOT EXISTS evolution_instance  text,
    ADD COLUMN IF NOT EXISTS evolution_token_enc text;
