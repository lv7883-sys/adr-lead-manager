-- ============================================================
-- 104 — Badge de não-lidas: "RESPONDER = LER" (backfill único).
--
-- PROBLEMA: o badge aparecia inflado. Causa: a recepção responde pelo WhatsApp WEB, e a LEITURA
-- feita no Web NÃO volta como recibo pra nossa conexão (Evolution) — então o last_read_at não
-- avançava e conversas JÁ ATENDIDAS continuavam contando como não-lidas. (Confirmado: o próprio
-- unreadCount do Evolution é ainda MAIS inflado — 800+ não-lidas em 3 números — pelo mesmo motivo,
-- então espelhá-lo não é opção.) O sinal CONFIÁVEL que temos é a RESPOSTA (o eco fromMe sempre volta).
--
-- REGRA: uma saída HUMANA 1:1 (source de app WhatsApp: web/android/ios/desktop — NÃO 'api'/automático)
-- marca a conversa como lida até o instante da resposta. Daqui pra frente isso é feito no INSERT do
-- eco (src/staffSamples.js captureOutbound). Este backfill aplica a mesma regra ao histórico existente.
--
-- Backfill único (dados, não schema). Idempotente (só avança last_read_at; GREATEST + guarda).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 104_badge_lidas_responder_e_ler.sql
-- ============================================================

UPDATE lead_manager.conversations c
   SET last_read_at = GREATEST(COALESCE(c.last_read_at, 'epoch'::timestamptz), sub.ult_resp)
  FROM (
    SELECT cv.id, max(s.received_at) AS ult_resp
      FROM lead_manager.conversations cv
      JOIN lead_manager.staff_outbound_samples s
        ON s.tenant_id = cv.tenant_id AND NOT s.is_group
       AND s.source IN ('web', 'android', 'ios', 'desktop')
       AND regexp_replace(s.external_id, '[^0-9]', '', 'g') = regexp_replace(cv.external_id, '[^0-9]', '', 'g')
     GROUP BY cv.id
  ) sub
 WHERE c.id = sub.id AND (c.last_read_at IS NULL OR c.last_read_at < sub.ult_resp);
