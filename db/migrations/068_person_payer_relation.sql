-- ============================================================
-- ADR-037 (emenda) — responsabilidade financeira do BENEFICIÁRIO (canônico neutro).
-- ADITIVA: lead_manager.person.payer_relation (nullable). Conceito GENÉRICO:
--   self_paid              = o beneficiário paga o próprio serviço;
--   financially_dependent  = há um responsável financeiro por ele.
-- O código cru da fonte (ex.: tpresp 0/1/2 da Extranet) é traduzido PELO ADAPTER e nunca
-- chega aqui. Nada preso a Valinhos/escola. Herda RLS/posse/policies da tabela.
--
-- Migrations manuais (NUNCA db push):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 068_person_payer_relation.sql
-- ============================================================

ALTER TABLE lead_manager.person
  ADD COLUMN IF NOT EXISTS payer_relation text;   -- self_paid | financially_dependent | NULL

COMMENT ON COLUMN lead_manager.person.payer_relation IS
  'Responsabilidade financeira do beneficiário (canônico neutro): self_paid | financially_dependent. NULL = desconhecido. Traduzido pelo adapter da fonte (ex.: tpresp da Extranet); o código cru não chega aqui.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'person_payer_relation_check') THEN
    ALTER TABLE lead_manager.person
      ADD CONSTRAINT person_payer_relation_check
      CHECK (payer_relation IS NULL OR payer_relation IN ('self_paid','financially_dependent'));
  END IF;
END $$;

-- ROLLBACK (manual, não-destrutivo):
--   ALTER TABLE lead_manager.person DROP CONSTRAINT IF EXISTS person_payer_relation_check;
--   ALTER TABLE lead_manager.person DROP COLUMN IF EXISTS payer_relation;
