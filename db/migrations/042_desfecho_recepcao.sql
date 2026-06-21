-- ============================================================================
-- 042_desfecho_recepcao.sql — Desfecho confirmado pela RECEPÇÃO (fonte primária,
-- prioridade humana) + ground-truth de conversão.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 042_desfecho_recepcao.sql
--
-- Genérico/multi-tenant: o controle fala em outcomes GENÉRICOS (won/lost/open); os
-- LABELS de display e o mapeamento pro valor legado de `leads.desfecho` (back-compat
-- com kanban/métricas) vivem num CATÁLOGO por-tenant (espelha lead_definition).
-- `desfecho_source` marca quem cravou (recepcao agora; extranet/ia depois → humano
-- tem prioridade, divergência vira flag). Aditiva e idempotente.
-- ============================================================================

-- Quem cravou o desfecho + o motivo genérico (chip), preservando o sinal mesmo quando
-- o valor legado (`desfecho`) colapsa vários motivos num só.
ALTER TABLE lead_manager.leads
    ADD COLUMN IF NOT EXISTS desfecho_source text,   -- 'recepcao' | 'extranet' | 'ia'
    ADD COLUMN IF NOT EXISTS desfecho_motivo text;   -- chave genérica do motivo (lost)

-- Catálogo de desfecho por-tenant: outcomes genéricos + labels + mapa pro valor legado.
ALTER TABLE lead_manager.tenant_lead_config
    ADD COLUMN IF NOT EXISTS desfecho_catalog jsonb;

-- Seed do ADR Valinhos (parametrizável; outro tenant pode sobrescrever, ou cai no
-- default em código com a mesma forma). 'won' marca CONVERTED; 'lost' tem chips de
-- motivo (mapeados pros valores legados de leads.desfecho); 'open' limpa o desfecho.
UPDATE lead_manager.tenant_lead_config
   SET desfecho_catalog = '{
     "outcomes": [
       { "key": "won",  "label": "Matriculou", "desfecho": "matriculado", "status": "CONVERTED" },
       { "key": "lost", "label": "Não fechou", "motivos": [
           { "key": "preco",        "label": "Preço",         "desfecho": "nao_matriculado_preco" },
           { "key": "sem_retorno",  "label": "Sem retorno",   "desfecho": "nao_matriculado_desistiu" },
           { "key": "outro_curso",  "label": "Escolheu outro","desfecho": "nao_matriculado_concorrente" },
           { "key": "sem_interesse","label": "Sem interesse", "desfecho": "outro" }
       ] },
       { "key": "open", "label": "Em aberto", "desfecho": null }
     ]
   }'::jsonb
 WHERE tenant_id = 'ed731a58-62e5-45ad-acba-a5502ff39e92'
   AND desfecho_catalog IS NULL;

-- Backfill do source: desfechos que já existem foram cravados pela recepção (única
-- fonte até agora) — marca como tal pra não virarem "sem fonte" quando a Extranet vier.
UPDATE lead_manager.leads
   SET desfecho_source = 'recepcao'
 WHERE desfecho IS NOT NULL AND desfecho_source IS NULL;
