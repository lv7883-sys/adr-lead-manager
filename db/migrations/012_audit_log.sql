-- ============================================================
-- Trilha de auditoria (item de segurança 3 — direito ao esquecimento e além).
-- Aplicável pelo lead_manager_user. Sem FK e sem RLS de propósito (mesmo padrão
-- de impersonation_audit): a trilha sobrevive à exclusão/anonimização e pode ser
-- revisada pela plataforma. NÃO guarda PII (só ids e a ação).
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.audit_log (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid,                       -- sem FK (trilha sobrevive ao tenant)
    actor       text,                       -- id do usuário (req.user.sub) ou papel
    action      text NOT NULL,              -- ex.: 'lead.forget'
    target_type text,                       -- ex.: 'lead'
    target_id   text,                       -- ex.: lead_id
    details     jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON lead_manager.audit_log (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON lead_manager.audit_log (target_type, target_id);

GRANT SELECT, INSERT ON lead_manager.audit_log TO lead_manager_user;
