-- ============================================================
-- ADR-027 (#8 Fase 2) — HIGIENE do ledger de reabordagem. ADITIVA + IDEMPOTENTE (rodar 2× não quebra).
-- (1) enviado_em deixa de mentir: DROP DEFAULT now() → passa a significar SÓ "enviado de verdade".
-- (2) purga pendentes de leads que não são mais candidatos a reativação (status/desfecho/não-dormente).
-- (3) dedup: colapsa pendentes duplicados → 1 por (tenant_id, lead_id), mantendo o mais recente.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 073_reabordagem_cleanup.sql
--
-- Fase 1 (re-fonte do chip, já no ar) NÃO depende desta tabela pra "enviado" (lê staff_outbound_samples);
-- ela só é lida como fila de sugestão (status='pendente'). Logo limpar aqui é seguro pro chip.
-- BACKUP antes (é DELETE de dados). Multi-tenant: dedup por (tenant_id,lead_id); purga usa dormancy_days por tenant.
-- ROLLBACK do DDL: ALTER TABLE lead_manager.reabordagem_tentativas ALTER COLUMN enviado_em SET DEFAULT now();
--                  (os DELETEs de dados não têm rollback — restaurar do backup se preciso.)
-- ============================================================

-- (1) COLUNA HONESTA — enviado_em só é preenchido quando há envio real (os dois caminhos de
--     INSERT já passam o valor explícito: pendente→NULL, enviado→now()). DROP DEFAULT é idempotente.
ALTER TABLE lead_manager.reabordagem_tentativas ALTER COLUMN enviado_em DROP DEFAULT;

COMMENT ON COLUMN lead_manager.reabordagem_tentativas.enviado_em IS
  '#8 Fase 2: timestamp do ENVIO real (status=enviado). NULL enquanto pendente/ignorado. NÃO é hora de geração.';

-- (2) PURGA — pendente cujo lead não é mais candidato a reativação:
--     (a) status fora de QUALIFYING/QUALIFIED, ou desfecho definido; OU
--     (b) não está mais dormente (última atividade dentro de dormancy_days do tenant, default 7).
DELETE FROM lead_manager.reabordagem_tentativas rt
 USING lead_manager.leads l
  LEFT JOIN lead_manager.tenant_lead_config tc ON tc.tenant_id = l.tenant_id
 WHERE rt.status = 'pendente'
   AND rt.lead_id = l.id
   AND (
        l.status NOT IN ('QUALIFYING','QUALIFIED')
     OR l.desfecho IS NOT NULL
     OR COALESCE((
          SELECT max(x.at) FROM (
            SELECT max(m.received_at) AS at
              FROM lead_manager.messages m
              JOIN lead_manager.conversations cv ON cv.id = m.conversation_id
             WHERE cv.external_id = l.phone AND m.role = 'USER'
            UNION ALL
            SELECT max(s.received_at)
              FROM lead_manager.staff_outbound_samples s
             WHERE regexp_replace(s.external_id,'[^0-9]','','g')
                 = regexp_replace(coalesce(l.phone, l.meta_psid, ''),'[^0-9]','','g')
          ) x
        ), 'epoch'::timestamptz)
        >= now() - make_interval(days => COALESCE(NULLIF(tc.dormancy_days, 0), 7))
   );

-- (3) DEDUP — mantém 1 pendente por (tenant_id, lead_id): o mais recente (enviado_em DESC; NULLs
--     primeiro = pós-fix mais novo; id como desempate). Idempotente: 2ª execução não acha duplicata.
DELETE FROM lead_manager.reabordagem_tentativas
 WHERE status = 'pendente'
   AND id IN (
     SELECT id FROM (
       SELECT id, row_number() OVER (
                     PARTITION BY tenant_id, lead_id
                     ORDER BY enviado_em DESC NULLS FIRST, id DESC) AS rn
         FROM lead_manager.reabordagem_tentativas
        WHERE status = 'pendente'
     ) d
      WHERE d.rn > 1
   );
