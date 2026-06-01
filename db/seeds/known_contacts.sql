-- ============================================================
-- E1-01 | Seed manual de known_contacts (Portão 0).
-- Cadastra números que NUNCA devem ser tratados como lead.
--
-- Uso (substitua :tenant e o telefone):
--   docker exec -i <pg_container> psql -U postgres -d adr_scheduler \
--     -v tenant="'<TENANT_UUID>'" -f known_contacts.sql
--
-- Telefones em E.164 (ex.: +5511999998888). type ∈ STAFF|STUDENT|SUPPLIER|OTHER.
-- ============================================================

-- Exige o contexto RLS quando rodado como lead_manager_user; como postgres
-- (superuser) o set_config é inofensivo e mantém o script idêntico nos dois casos.
SELECT set_config('app.current_tenant', :tenant, false);

INSERT INTO lead_manager.known_contacts (tenant_id, phone, type, source) VALUES
  (:tenant::uuid, '+5511988887777', 'STAFF', 'MANUAL')   -- número de teste (equipe interna)
ON CONFLICT (tenant_id, phone) DO NOTHING;

SELECT phone, type, source FROM lead_manager.known_contacts WHERE tenant_id = :tenant::uuid;
