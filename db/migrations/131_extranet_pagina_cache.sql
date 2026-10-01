-- ============================================================================
-- 131_extranet_pagina_cache.sql — GUARDA O QUE JÁ FOI LIDO da Extranet.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 131_....sql
--
-- O PROBLEMA (medido em 30/09/2026)
--   A coleta diária de cadastro faz ~1.535 requisições com intervalo de 25 s (anti-bloqueio) e
--   leva ~11h30 (651 a 699 min nos últimos 8 dias). Ela monta o snapshot INTEIRO em memória e só
--   grava no fim. Em 30/09 uma falha de rede na décima hora ("fetch failed") descartou as 11 horas
--   de trabalho: nada do que já tinha sido lido foi aproveitado.
--
-- POR QUE NÃO BASTA "GRAVAR O PARCIAL"
--   Snapshot parcial escrito como se fosse completo marcaria centenas de contratos como sumidos da
--   Extranet. A salvaguarda de queda (CADASTRO_SAFEGUARD_MAX_DROP, 34%) existe exatamente para
--   impedir isso e NÃO É AFROUXADA aqui. O que esta tabela guarda é a MATÉRIA-PRIMA — cada página
--   já lida —, não o resultado. O snapshot continua sendo montado completo antes de qualquer
--   escrita no cadastro.
--
-- O QUE MUDA NA PRÁTICA
--   • falha no meio: a execução seguinte reaproveita o que já foi lido e termina em minutos;
--   • dia normal: a lista de contratos já diz quem mudou (curso, vigência, status, nome), então só
--     o que mudou é rebuscado — de 1.535 requisições para dezenas;
--   • dado que muda sem aparecer na lista (telefone, nascimento, responsável) é revalidado por
--     prazo de validade com dispersão (5 a 9 dias por chave, para não vencer tudo no mesmo dia)
--     e por amostragem de verificação a cada execução.
--
-- NÃO GUARDA HTML: só os campos já extraídos. Menos volume, e nada de segredo de sessão no banco.
-- Conteúdo é dado de cadastro (nome, telefone, nascimento) — mesmo grau de sensibilidade de
-- lead_manager.person, e cai no mesmo isolamento por unidade.
--
-- REVERSÃO: `DROP TABLE lead_manager.extranet_pagina_cache;` e a coleta volta a buscar tudo todo
-- dia, exatamente como hoje. Nenhuma outra tabela é tocada. O coletor também aceita
-- CADASTRO_CACHE=off, que ignora a tabela sem precisar de migração de volta.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lead_manager.extranet_pagina_cache (
  tenant_id    uuid        NOT NULL,
  tipo         text        NOT NULL CHECK (tipo IN ('detalhe_contrato', 'ficha_aluno')),
  chave        text        NOT NULL,          -- id do contrato (idC) ou do aluno (idA) na Extranet
  -- Assinatura do que a LISTA já mostrava quando esta página foi lida (curso|início|fim|status|nome).
  -- Mudou a assinatura => a página é rebuscada, sem esperar o prazo de validade. NULL = sem sinal
  -- de mudança disponível (caso da ficha do aluno), aí só o prazo e a amostragem valem.
  assinatura   text,
  conteudo     jsonb       NOT NULL,          -- campos JÁ EXTRAÍDOS (nunca a página crua)
  buscado_em   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tipo, chave)
);

COMMENT ON TABLE lead_manager.extranet_pagina_cache IS
  'Matéria-prima já lida da Extranet (detalhe de contrato e ficha de aluno). Existe para que uma '
  'falha de rede no meio de uma coleta de 11h não descarte o que já foi obtido, e para não '
  'rebuscar diariamente páginas que não mudaram. Não substitui o snapshot completo: a salvaguarda '
  'de queda continua valendo antes de qualquer escrita no cadastro.';

ALTER TABLE lead_manager.extranet_pagina_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.extranet_pagina_cache FORCE  ROW LEVEL SECURITY;

-- Mesma política do resto do schema lead_manager (tenant SEMPRE uuid neste caminho: quem escreve é
-- o coletor do LM, dentro de withTenant). Tabelas lidas também pelo painel/BI usam comparação em
-- texto, porque lá o tenant pode ser cuid ou inteiro e o cast derruba a requisição — não é o caso.
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.extranet_pagina_cache;
CREATE POLICY tenant_isolation ON lead_manager.extranet_pagina_cache
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.extranet_pagina_cache TO lead_manager_user;
