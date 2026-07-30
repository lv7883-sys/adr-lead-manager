-- ============================================================
-- 083 — ADR-042: FAVORITAS por USUÁRIO. Cada recepcionista tem as suas favoritas
-- (favorited_by = id do usuário do dashboard). Troca o índice único de (tenant_id, message_id)
-- p/ (tenant_id, message_id, favorited_by), permitindo que usuários diferentes favoritem a
-- MESMA mensagem. Aditiva e segura (a tabela nasceu hoje; 0 registros em prod).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 083_message_favorites_por_usuario.sql
-- ============================================================

DROP INDEX IF EXISTS lead_manager.uq_msg_fav_tenant_msg;
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_fav_tenant_msg_user
    ON lead_manager.message_favorites (tenant_id, message_id, favorited_by);

-- ROLLBACK (manual):
--   DROP INDEX IF EXISTS lead_manager.uq_msg_fav_tenant_msg_user;
--   CREATE UNIQUE INDEX uq_msg_fav_tenant_msg ON lead_manager.message_favorites (tenant_id, message_id);
