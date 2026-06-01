-- ============================================================
-- Provisionamento do tenant piloto: ADR Valinhos.
-- Rodar como superuser "postgres" (bypassa RLS):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f seed_tenant_valinhos.sql
-- Idempotente: não duplica se o tenant 'ADR Valinhos' já existir.
-- ============================================================

DO $$
DECLARE
    v_tenant uuid;
    v_token  text;
BEGIN
    SELECT id INTO v_tenant FROM lead_manager.tenants WHERE name = 'ADR Valinhos' LIMIT 1;

    IF v_tenant IS NULL THEN
        v_tenant := gen_random_uuid();
        -- token aleatório (64 hex): dois uuids sem hífen concatenados.
        v_token  := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

        INSERT INTO lead_manager.tenants (id, name, lead_manager_active, zapi_token)
        VALUES (v_tenant, 'ADR Valinhos', true, v_token);

        -- Assinatura ACTIVE da feature LEAD_MANAGER (gating libera o processamento).
        INSERT INTO lead_manager.tenant_subscriptions
            (tenant_id, feature, status, valid_until, converted_at)
        VALUES (v_tenant, 'LEAD_MANAGER', 'ACTIVE', now() + interval '1 year', now());

        -- Configuração do Lead Manager.
        INSERT INTO lead_manager.tenant_lead_config
            (tenant_id, school_name, available_instruments, business_hours, notification_whatsapp)
        VALUES (
            v_tenant,
            'Academia do Rock Valinhos',
            ARRAY['guitarra', 'violão', 'baixo', 'bateria', 'teclado', 'canto'],
            '{"mon":"09:00-20:00","tue":"09:00-20:00","wed":"09:00-20:00","thu":"09:00-20:00","fri":"09:00-20:00","sat":"09:00-18:00","sun":"closed"}'::jsonb,
            ''  -- notification_whatsapp: vazio por enquanto
        );

        RAISE NOTICE 'Tenant ADR Valinhos CRIADO: %', v_tenant;
    ELSE
        RAISE NOTICE 'Tenant ADR Valinhos JÁ EXISTE: % (nada alterado)', v_tenant;
    END IF;
END $$;

-- Saída: dados que serão usados para configurar o webhook no Z-API.
SELECT id AS tenant_id, zapi_token, lead_manager_active
  FROM lead_manager.tenants
 WHERE name = 'ADR Valinhos';
