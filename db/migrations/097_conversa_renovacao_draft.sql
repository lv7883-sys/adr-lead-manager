-- ============================================================
-- 097 — RENOVAÇÃO Fase B: conversa "rascunho" de renovação (aberta a partir do gráfico de Retenção).
-- Quando a recepção clica num contrato no gráfico, criamos/abrimos a conversa daquele telefone com um
-- texto sugerido pela IA. Enquanto a 1ª mensagem NÃO foi enviada, essa conversa fica SÓ na aba
-- Renovação da Caixa de Entrada — NÃO polui a Caixa normal (Todas/Leads/Outras). Ao enviar, o flag
-- some e a conversa passa a aparecer na Caixa normal (igual ao WhatsApp quando você manda a 1ª msg).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 097_conversa_renovacao_draft.sql
-- ============================================================

ALTER TABLE lead_manager.conversations ADD COLUMN IF NOT EXISTS renovacao_draft boolean NOT NULL DEFAULT false;

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.conversations DROP COLUMN IF EXISTS renovacao_draft;
