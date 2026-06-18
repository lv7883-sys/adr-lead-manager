-- ============================================================================
-- SYNC idempotente: professores (app.professor_notificacao) -> internal_contacts
-- (type='professor'). Mecanismo GENÉRICO; o que é específico do ADR fica isolado
-- no mapa `franquia_tenant` abaixo (dado por cima, extensível: adicione linhas).
--
-- Normalização: telefone efetivo = coalesce(telefone_override, telefone), em
-- dígitos, com prefixo 55 em números de 10/11 díg (mesma regra do cadastro
-- _normalizaTelefoneBR) — OBRIGATÓRIO p/ casar com o Gate 0 (engine.js), que
-- compara leads (já com 55) contra internal_contacts por dígitos.
--
-- Idempotente: ON CONFLICT (tenant_id, phone) DO UPDATE. Re-rodar é seguro.
-- Cross-schema no mesmo banco (app + lead_manager em adr_scheduler).
-- ============================================================================
BEGIN;

WITH
-- >>> MAPA ADR (único ponto a editar p/ novos tenants) <<<
-- franquia_id (app.franquia) -> tenant_id (lead_manager.tenants).
-- Hoje só Valinhos tem LM ativo. Campinas-Cambuí (franquia 5) fica fora até
-- existir tenant LM — basta acrescentar a linha quando houver.
franquia_tenant(franquia_id, tenant_id) AS (
  VALUES
    (1, 'ed731a58-62e5-45ad-acba-a5502ff39e92'::uuid)   -- Franquia Valinhos -> ADR Valinhos
    -- ,(5, '<tenant_uuid>'::uuid)                        -- Campinas-Cambuí (sem tenant LM ainda)
),
src AS (
  SELECT ft.tenant_id,
         CASE WHEN length(d.digi) IN (10, 11) THEN '55' || d.digi ELSE d.digi END AS phone,
         pn.nome
    FROM app.professor_notificacao pn
    JOIN franquia_tenant ft ON ft.franquia_id = pn.franquia_id
    CROSS JOIN LATERAL (
      SELECT regexp_replace(coalesce(pn.telefone_override, pn.telefone, ''), '[^0-9]', '', 'g') AS digi
    ) d
   WHERE d.digi <> ''
)
INSERT INTO lead_manager.internal_contacts (tenant_id, phone, name, type)
SELECT tenant_id, phone, coalesce(nullif(btrim(nome), ''), 'Professor'), 'professor'
  FROM src
ON CONFLICT (tenant_id, phone) DO UPDATE
  SET name = EXCLUDED.name, type = 'professor';

COMMIT;
