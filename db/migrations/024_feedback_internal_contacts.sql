-- ============================================================
-- Enriquece classification_feedback + cria internal_contacts (ADR-018 parcial).
-- (023 já criou a classification_feedback simples; aqui complementa.)
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 024_feedback_internal_contacts.sql
-- ============================================================

-- classification_feedback: confidence/reasoning originais + CHECK do rótulo.
ALTER TABLE lead_manager.classification_feedback
  ADD COLUMN IF NOT EXISTS original_confidence decimal(4,3),
  ADD COLUMN IF NOT EXISTS original_reasoning  text;
ALTER TABLE lead_manager.classification_feedback
  DROP CONSTRAINT IF EXISTS classification_feedback_correct_label_check,
  ADD CONSTRAINT classification_feedback_correct_label_check
    CHECK (correct_label IN ('lead', 'not_lead', 'internal'));

-- internal_contacts: números internos (equipe/parceiros) que NÃO viram lead.
CREATE TABLE IF NOT EXISTS lead_manager.internal_contacts (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  phone      text NOT NULL,
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN ('gestor','recepcionista','professor','funcionario','parceiro','outro')),
  created_at timestamptz DEFAULT now(),
  UNIQUE (tenant_id, phone)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.internal_contacts TO lead_manager_user;

-- Popula Valinhos (ed731a58…): linha da recepção + a gestora.
INSERT INTO lead_manager.internal_contacts (tenant_id, phone, name, type) VALUES
  ('ed731a58-62e5-45ad-acba-a5502ff39e92', '5519997078916', 'Rafaela', 'recepcionista'),
  ('ed731a58-62e5-45ad-acba-a5502ff39e92', '554199510828',  'Daniele', 'gestor')
ON CONFLICT (tenant_id, phone) DO NOTHING;
