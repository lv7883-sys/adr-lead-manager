-- ============================================================
-- 088 — ADR-006+/ADR-042: base de conhecimento da IA fora do horário ("Janis").
-- Texto livre que a escola preenche (endereço, como funcionam as aulas — individuais, projetos
-- de banda, eventos…). A auto-resposta usa SÓ isso p/ responder dúvidas gerais fora do horário;
-- preço e agendamento de aula experimental continuam bloqueados (só recepção). ADITIVA.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 088_automacao_contexto_ia.sql
-- ============================================================

ALTER TABLE lead_manager.automacao_config ADD COLUMN IF NOT EXISTS contexto_ia text;

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.automacao_config DROP COLUMN IF EXISTS contexto_ia;
