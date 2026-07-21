-- ============================================================
-- ADR-036 E1.5 / ADR-037 — PAPÉIS-BASE CANÔNICOS por-tenant (elimina a dívida multi-tenant).
-- Antes: os papéis 'aluno'/'responsavel' eram semeados só para Valinhos (hardcoded, 060).
-- Agora: uma FUNÇÃO genérica semeia os papéis-base canônicos para QUALQUER tenant no
-- provisionamento — `key` neutro (beneficiario/responsavel_financeiro/prestador), `label` é o
-- display por-tenant (a vertical/escola escolhe "Aluno", "Cliente", etc.). Nenhum vocabulário
-- de nicho no core; o significado de escola vive no ADAPTER.
--
-- ADITIVA: cria a função + canonicaliza os papéis existentes do Valinhos (rename de KEY,
-- role_id preservado → contact_role_member existentes seguem válidos) + aplica retroativo.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 069_canonical_roles_seed.sql
-- ============================================================

-- Semeia os papéis-base canônicos de um tenant (idempotente). Chamar no provisionamento de
-- QUALQUER tenant novo: SELECT lead_manager.seed_base_roles('<tenant_uuid>', '<label_benef>', ...);
-- Labels opcionais (default neutro) — a vertical passa o display que quiser.
CREATE OR REPLACE FUNCTION lead_manager.seed_base_roles(
  p_tenant       uuid,
  p_lbl_benef    text DEFAULT 'Beneficiário',
  p_lbl_resp     text DEFAULT 'Responsável financeiro',
  p_lbl_prest    text DEFAULT 'Prestador'
) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO lead_manager.contact_role (tenant_id, key, label, axis, suppression, lead_weight) VALUES
    (p_tenant, 'beneficiario',           p_lbl_benef, 'known',    'hard', 0),
    (p_tenant, 'responsavel_financeiro', p_lbl_resp,  'known',    'hard', 0),
    (p_tenant, 'prestador',              p_lbl_prest, 'internal', 'hard', 0)
  ON CONFLICT (tenant_id, key) DO NOTHING;
$$;
COMMENT ON FUNCTION lead_manager.seed_base_roles(uuid, text, text, text) IS
  'Semeia os papéis-base canônicos (beneficiario/responsavel_financeiro/prestador) de um tenant. Idempotente. Chamar no provisionamento de qualquer tenant — sem código específico por tenant.';

-- Retroativo Valinhos: canonicaliza os papéis existentes (rename de KEY; label mantém o display
-- de escola). role_id preservado → os contact_role_member (111 beneficiários, 176 responsáveis,
-- 22 prestadores) continuam válidos. Idempotente (só renomeia se ainda estiver no nome antigo).
UPDATE lead_manager.contact_role SET key='beneficiario'
  WHERE tenant_id='ed731a58-62e5-45ad-acba-a5502ff39e92' AND key='aluno';
UPDATE lead_manager.contact_role SET key='responsavel_financeiro'
  WHERE tenant_id='ed731a58-62e5-45ad-acba-a5502ff39e92' AND key='responsavel';
UPDATE lead_manager.contact_role SET key='prestador'
  WHERE tenant_id='ed731a58-62e5-45ad-acba-a5502ff39e92' AND key='professor';

-- Garante os 3 canônicos (adiciona o que faltar; os renomeados caem no ON CONFLICT).
SELECT lead_manager.seed_base_roles('ed731a58-62e5-45ad-acba-a5502ff39e92', 'Aluno', 'Responsável', 'Professor');

-- ROLLBACK (manual): reverter os renames + DROP FUNCTION seed_base_roles.
--   UPDATE lead_manager.contact_role SET key='aluno' WHERE tenant_id='ed731a58-...' AND key='beneficiario';
--   UPDATE lead_manager.contact_role SET key='responsavel' WHERE tenant_id='ed731a58-...' AND key='responsavel_financeiro';
--   UPDATE lead_manager.contact_role SET key='professor' WHERE tenant_id='ed731a58-...' AND key='prestador';
--   DROP FUNCTION IF EXISTS lead_manager.seed_base_roles(uuid, text, text, text);
