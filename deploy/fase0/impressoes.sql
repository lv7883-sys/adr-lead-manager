-- impressoes.sql — ADR-051 Fase 0. "Impressões digitais" de perda que a contagem de linhas NÃO vê
-- (UPDATE destrutivo: anonimização, sobrescrita com vazio). Só leitura, banco adr_scheduler.
-- Saída: nome<TAB>valor. Regra de alerta: qualquer AUMENTO de um dia para o outro.
SET default_transaction_read_only = on;
SET statement_timeout = '120s';
SELECT 'impressao.messages_corpo_removido', count(*) FROM lead_manager.messages WHERE body = '[removido]'
UNION ALL
SELECT 'impressao.leads_anonimizados', count(*) FROM lead_manager.leads WHERE phone LIKE 'anonimizado_%'
UNION ALL
SELECT 'impressao.conversas_anonimizadas', count(*) FROM lead_manager.conversations WHERE external_id LIKE 'anonimizado_%'
UNION ALL
SELECT 'impressao.contratos_sem_professor', count(*) FROM lead_manager.service_account WHERE professor_nome IS NULL
UNION ALL
SELECT 'impressao.contratos_sem_tipo_saida', count(*) FROM lead_manager.service_account WHERE tipo_saida IS NULL
ORDER BY 1;
