-- ============================================================================
-- 183_marca_contrato_de_teste_da_recepcao.sql
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 183_....sql
--
-- POR QUÊ
--   A 182 devolveu ao funil 3 dos 4 NOT_LEAD com contrato posterior ao primeiro contato. O 4º é a
--   Késsia Rebac: o Leo confirmou em 26/09/2026 que é a recepcionista testando o novo modelo de
--   contrato COM ELA MESMA — contrato real na Extranet, matrícula nenhuma.
--
--   O relatório semanal novo (src/jobs/relatorio-naolead-com-contrato.js) acha esse caso por
--   PROPRIEDADE, então ele voltaria a alertar toda semana sobre alguém já decidido. Alerta que toca
--   sempre é alerta que ninguém lê — e aí o caso NOVO, o que importa, passa junto com o ruído.
--
-- COMO (reusando convenção, sem inventar coluna nem lista no código)
--   suggested_stage_dismissed='convertido' é a marca que a guarda 4 do fechaPorContrato já respeita
--   ("reversão respeitada": o que a recepção dispensou não é re-fechado no dia seguinte). O
--   relatório passa a filtrar pela MESMA marca. Qualquer caso futuro se resolve do mesmo jeito,
--   pela tela, sem migração.
--
-- Não mexe em status, desfecho, funil, nem no contrato. Só registra uma decisão que já existia na
-- conversa e não existia no banco. Idempotente. Reversível: basta limpar a coluna.
-- ============================================================================

BEGIN;

\set tid 'ed731a58-62e5-45ad-acba-a5502ff39e92'
\set kessia '82f6edff-558d-4b33-b48b-dc3b74ecf1f0'

UPDATE lead_manager.leads
   SET suggested_stage_dismissed = 'convertido', updated_at = now()
 WHERE tenant_id = :'tid' AND id = :'kessia'::uuid
   AND coalesce(suggested_stage_dismissed, '') <> 'convertido';

INSERT INTO lead_manager.lead_eventos (tenant_id, lead_id, tipo, autor, conteudo)
SELECT :'tid'::uuid, :'kessia'::uuid, 'nota', 'migracao-183',
       'Contrato de 20/08/2026 (Baixo) e TESTE do novo modelo de contrato feito pela recepcao com '
       || 'ela mesma, confirmado pelo Leo em 26/09/2026 -- nao e captacao. Marcado como dispensado '
       || 'para "convertido" para o relatorio de NOT_LEAD com contrato nao alertar sobre um caso ja '
       || 'decidido. Nao entra no funil (sem fato na Extranet) e o contrato esta nao-pagante.'
 WHERE EXISTS (SELECT 1 FROM lead_manager.leads WHERE id = :'kessia'::uuid AND tenant_id = :'tid');

\echo '--- depois ---'
SELECT name, status, desfecho, suggested_stage_dismissed
  FROM lead_manager.leads WHERE id = :'kessia'::uuid;

COMMIT;
