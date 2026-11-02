-- ============================================================
-- 188 — COLUNAS DO KANBAN POR UNIDADE: renomear, esconder e ACRESCENTAR.
--
-- Pedido do Leo em 02/11/2026, reafirmado depois de eu recomendar o contrário: ele quer poder
-- editar e inserir colunas. Esta migração abre as duas portas, e o desenho delas sai de uma
-- medição, não de preferência.
--
-- ─── A MEDIÇÃO QUE DECIDIU ONDE A COLUNA EXTRA MORA ─────────────────────────────────────────
--
-- O caminho óbvio seria guardar a coluna extra em `leads.status`. Ele está ERRADO, e dá para
-- provar: a partição canônica (src/stages.js) termina assim, nas DUAS pontas —
--
--     JS:   ... if (status === 'QUALIFIED') return 'qualificado';
--           return 'qualificando';                 ← qualquer status desconhecido
--     SQL:  ... WHEN status = 'QUALIFIED' THEN 'qualificado'
--           ELSE 'qualificando' END                ← idem
--
-- Ou seja: um status novo cai em "Qualificando" POR ELIMINAÇÃO. O lead apareceria na coluna
-- extra do quadro E seria contado como qualificando em todo o resto — funil, BI, métricas, fila
-- de ação. Dois lugares ao mesmo tempo, sem erro nenhum. É a forma de defeito que este projeto
-- mais paga, e ela estaria embutida no desenho.
--
-- ─── ENTÃO A COLUNA EXTRA É UMA VISTA, NÃO UM ESTADO ────────────────────────────────────────
--
-- `leads.etapa_custom` é uma coluna SEPARADA e NULA para todo mundo. Quando preenchida, ela muda
-- apenas ONDE O CARD APARECE no quadro. O `status` continua intacto — então o funil, o BI e as
-- taxas de conversão seguem medindo exatamente as mesmas cinco etapas, e continuam comparáveis
-- entre unidades. Uma unidade pode organizar o quadro como quiser sem reescrever o que a
-- empresa mede.
--
-- A contrapartida, dita por extenso: um lead numa coluna extra CONTINUA contando na etapa
-- canônica dele no funil. Isso é a feature, não um defeito — e é o que faz a coluna extra ser
-- barata em vez de perigosa.
--
-- ─── E A CONFIGURAÇÃO FICA JUNTO DA CONFIGURAÇÃO ────────────────────────────────────────────
--
-- `tenant_lead_config.stage_ui` guarda rótulo/ícone/dica por coluna, quais esconder e quais
-- acrescentar. Vizinha de `stage_definitions`, que já guarda a descrição que a IA lê. Default
-- `'{}'` = nada configurado = o quadro de hoje, byte a byte, para TODA unidade existente.
--
-- ADITIVA: dois ADD COLUMN IF NOT EXISTS, ambos com default que preserva o comportamento atual.
-- Nada de DROP, nenhum dado alterado, nenhuma linha reescrita (default constante → metadados-only
-- no PG11+). Faixa 188 reservada em db/migrations/RESERVAS.md.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 188_kanban_colunas_da_unidade.sql
-- ============================================================

-- 1) Como a unidade quer ver o quadro. Validado em src/stagesUi.js (puro, testado sem banco).
ALTER TABLE lead_manager.tenant_lead_config
  ADD COLUMN IF NOT EXISTS stage_ui jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN lead_manager.tenant_lead_config.stage_ui IS
  'Colunas do kanban DESTA unidade: {rotulos:{<key>:{label,emoji,dica}}, ocultas:[<key>], '
  'extras:[{key,label,emoji,dica,depois}]}. Vazio = o quadro canônico de src/stages.js. '
  'Só APARÊNCIA e POSIÇÃO: a partição do funil, o status e as taxas do BI não dependem disto.';

-- 2) Onde o card aparece, quando a unidade criou uma coluna. NULL = onde a régua canônica manda.
ALTER TABLE lead_manager.leads
  ADD COLUMN IF NOT EXISTS etapa_custom text;

COMMENT ON COLUMN lead_manager.leads.etapa_custom IS
  'Coluna EXTRA (criada pela unidade) em que este lead aparece no kanban. NULL = a coluna '
  'canônica derivada de status/desfecho. ⚠ NÃO é estado de ciclo de vida: o funil, o BI e a fila '
  'continuam lendo `status`. Guardar isto em `status` faria o lead cair em "qualificando" por '
  'eliminação no ELSE de stages.stageSql() e ser contado DUAS vezes.';

-- Índice só onde há valor: a coluna é nula para a esmagadora maioria das linhas.
CREATE INDEX IF NOT EXISTS idx_leads_etapa_custom
  ON lead_manager.leads (tenant_id, etapa_custom) WHERE etapa_custom IS NOT NULL;

-- Conferência (read-only) — o esperado logo após esta migração:
--   SELECT count(*) FROM lead_manager.leads WHERE etapa_custom IS NOT NULL;            -- 0
--   SELECT count(*) FROM lead_manager.tenant_lead_config WHERE stage_ui <> '{}';       -- 0

-- ROLLBACK (manual):
--   DROP INDEX IF EXISTS lead_manager.idx_leads_etapa_custom;
--   ALTER TABLE lead_manager.leads DROP COLUMN IF EXISTS etapa_custom;
--   ALTER TABLE lead_manager.tenant_lead_config DROP COLUMN IF EXISTS stage_ui;
--   ⚠ Derrubar `etapa_custom` NÃO perde lead nenhum — só devolve cada card à coluna canônica
--     dele, que nunca deixou de ser a verdade.
