-- ============================================================================
-- Estado da conversa emitido pela IA (substitui a heurística de closer).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 036_conversation_state.sql
--
-- A IA (classifyConversa) passa a dizer EM QUE ESTADO a conversa está — com quem
-- está a bola e se já está resolvida — lendo a conversa inteira (contexto, não token).
-- Estados genéricos (multi-tenant):
--   AGUARDANDO_RECEPCAO | AGUARDANDO_CLIENTE | RESOLVIDO | INDEFINIDO
-- Consumido por: urgência da fila (responder_agora só em AGUARDANDO_RECEPCAO),
-- rascunho (não gera p/ RESOLVIDO) e Descartados (rede redundante de AGUARDANDO_RECEPCAO).
-- Segurança: na dúvida → INDEFINIDO, nunca RESOLVIDO (não esconder quem espera).
--
-- Aditiva e idempotente. NULL = ainda não computado (fallback _ehCloser na urgência).
-- ============================================================================

ALTER TABLE lead_manager.leads
    ADD COLUMN IF NOT EXISTS conversation_state text,
    ADD COLUMN IF NOT EXISTS state_reasoning    text,
    ADD COLUMN IF NOT EXISTS state_computed_at  timestamptz;

-- Índice parcial: a urgência/Descartados filtram por AGUARDANDO_RECEPCAO.
CREATE INDEX IF NOT EXISTS leads_conversation_state_idx
    ON lead_manager.leads (tenant_id, conversation_state)
    WHERE conversation_state IS NOT NULL;
