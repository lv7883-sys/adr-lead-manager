-- 109_renovacao_touchpoint_marcos.sql — amplia os marcos da régua de renovação.
-- A Fase 1 do sweep só rascunhava em D-10/D-2. Agora o sweep completa a régua original
-- (D-45/D-30/D-15/D-7), então o CHECK de `marco` precisa aceitar os novos valores.
-- Aditiva: mantém D-10/D-2 (já em produção). Sem backfill — o sweep gera daqui pra frente.
-- Aplicar como superusuário (DDL não é gated por RLS):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -X -q -v ON_ERROR_STOP=1 -f 109_renovacao_touchpoint_marcos.sql
BEGIN;

ALTER TABLE lead_manager.renovacao_touchpoint DROP CONSTRAINT IF EXISTS renovacao_touchpoint_marco_check;
ALTER TABLE lead_manager.renovacao_touchpoint ADD  CONSTRAINT renovacao_touchpoint_marco_check
  CHECK (marco IN ('D-45','D-30','D-15','D-10','D-7','D-2'));

COMMIT;
