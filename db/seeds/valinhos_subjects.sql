-- ADR-029 — SEED do vocabulário de assuntos de Valinhos (ed731a58…). Separado do DDL.
-- Só lead/not_lead agora; o schema é genérico p/ futuros assuntos (renovacao/reclamacao…).
INSERT INTO lead_manager.subject_definition (tenant_id, key, label, lead_bearing, sort_order) VALUES
 ('ed731a58-62e5-45ad-acba-a5502ff39e92','lead',     'Lead (matrícula)', true,  0),
 ('ed731a58-62e5-45ad-acba-a5502ff39e92','not_lead', 'Não é lead',       false, 1)
ON CONFLICT (tenant_id, key) DO NOTHING;
