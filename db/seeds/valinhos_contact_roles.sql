-- ADR-029 — SEED do vocabulário de papéis de Valinhos (ed731a58…). Separado do DDL.
-- Sem papel 'nao_lead': "não é lead" é ASSUNTO/ESTADO, não papel (vira discard_reason
-- + estado-por-histórico na fatia 3). `parceiro` fica internal/hard por ora (preserva o
-- comportamento atual — hoje está em internal_contacts e é hard-blocked); refinamento
-- p/ eixo 'known' fica sinalizado p/ depois.
INSERT INTO lead_manager.contact_role (tenant_id, key, label, axis, suppression, lead_weight) VALUES
 ('ed731a58-62e5-45ad-acba-a5502ff39e92','professor',   'Professor',   'internal','hard', 0),
 ('ed731a58-62e5-45ad-acba-a5502ff39e92','recepcao',    'Recepção',    'internal','hard', 0),
 ('ed731a58-62e5-45ad-acba-a5502ff39e92','gestao',      'Gestão',      'internal','hard', 0),
 ('ed731a58-62e5-45ad-acba-a5502ff39e92','dono',        'Dono',        'internal','hard', 0),
 ('ed731a58-62e5-45ad-acba-a5502ff39e92','funcionario', 'Funcionário', 'internal','hard', 0),
 ('ed731a58-62e5-45ad-acba-a5502ff39e92','parceiro',    'Parceiro',    'internal','hard', 0.05)
ON CONFLICT (tenant_id, key) DO NOTHING;
