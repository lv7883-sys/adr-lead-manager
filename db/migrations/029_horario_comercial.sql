-- ============================================================
-- Horário comercial por tenant — separa SLA dentro/fora do expediente.
-- dias: 1=segunda ... 5=sexta, 6=sábado, 7=domingo (ISO).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 029_horario_comercial.sql
-- ============================================================

ALTER TABLE lead_manager.tenants
  ADD COLUMN IF NOT EXISTS horario_comercial_inicio time DEFAULT '08:00',
  ADD COLUMN IF NOT EXISTS horario_comercial_fim    time DEFAULT '18:00',
  ADD COLUMN IF NOT EXISTS horario_comercial_dias   int[] DEFAULT '{1,2,3,4,5}';

-- Popula Valinhos (Seg-Sex 8h-18h).
UPDATE lead_manager.tenants
   SET horario_comercial_inicio = '08:00',
       horario_comercial_fim    = '18:00',
       horario_comercial_dias   = '{1,2,3,4,5}'
 WHERE id = 'ed731a58-62e5-45ad-acba-a5502ff39e92';
