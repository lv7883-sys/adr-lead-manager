-- ============================================================
-- Horário de atendimento — FAIXAS POR DIA (fonte única, H1).
-- Substitui (futuramente) o trio horario_comercial_inicio/fim/dias (029).
-- Estrutura jsonb:
--   { "1":[{"inicio":"09:00","fim":"22:00"}], "6":[{"inicio":"09:00","fim":"13:00"}], ... }
--   - chave = dia ISO 1=seg..7=dom; dia AUSENTE = fechado; lista vazia = fechado.
--   - múltiplas faixas/dia permitidas (prevê intervalo de almoço); [inicio,fim) fim exclusivo.
-- ADITIVA: NÃO dropa as colunas antigas (rollback seguro + retrocompat na transição).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 049_horario_comercial_jsonb.sql
-- ============================================================

ALTER TABLE lead_manager.tenants
  ADD COLUMN IF NOT EXISTS horario_comercial jsonb;

-- Converte o trio antigo → faixas-por-dia: cada dia marcado vira UMA faixa
-- [inicio,fim) idêntica (faixa-única atual → mesma faixa em todo dia marcado).
-- Equivalente ao veredito do dentroHorario() antigo: SLA não muda.
UPDATE lead_manager.tenants AS t
   SET horario_comercial = sub.j
  FROM (
    SELECT id,
           jsonb_object_agg(
             dia::text,
             jsonb_build_array(jsonb_build_object(
               'inicio', to_char(horario_comercial_inicio, 'HH24:MI'),
               'fim',    to_char(horario_comercial_fim,    'HH24:MI')
             ))
           ) AS j
      FROM lead_manager.tenants, unnest(horario_comercial_dias) AS dia
     WHERE horario_comercial_dias IS NOT NULL
       AND array_length(horario_comercial_dias, 1) > 0
     GROUP BY id, horario_comercial_inicio, horario_comercial_fim
  ) sub
 WHERE t.id = sub.id
   AND t.horario_comercial IS NULL;
