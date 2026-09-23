-- ============================================================================
-- 176 — O QUE A IA SUGERIU × O QUE FOI ENVIADO.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 176_sugestao_ia.sql
--
-- POR QUÊ
--   O Leo quer, um dia, ligar a resposta automática aos leads. Hoje NÃO EXISTE evidência
--   para tomar essa decisão — nem a favor, nem contra.
--
--   Medido em 22/09/2026 (Valinhos): o caminho que registrava alguma coisa (pending_approvals,
--   o antigo "modo observação") mostra que a sugestão da IA foi usada 20 vezes em junho,
--   41 em julho, 3 em agosto e ZERO em setembro. E o caminho que a recepção de fato usa —
--   o botão "Sugerir" dentro da conversa — não registra NADA: gera o texto, mostra na tela
--   e acabou. Não se sabe se foi enviado igual, editado ou descartado.
--
--   Ou seja: a assistente propõe dezenas de respostas por semana e ninguém nunca lhe diz
--   se acertou. É um funcionário em treinamento que nunca recebe retorno.
--
-- O QUE ESTA TABELA GUARDA
--   Só o FATO: o texto que a IA propôs, quando, para qual conversa e a pedido de quem.
--   O veredito (enviou igual / editou / escreveu do zero / não respondeu) NÃO é gravado —
--   ele é DERIVADO na leitura, comparando com a saída real que veio depois (src/aprendizado.js).
--   Lição de 22-23/09: estado derivado gravado em coluna envelhece e cada leitor compensa do
--   seu jeito; foi assim que "de quem é a bola" virou cinco réguas diferentes. Aqui a régua de
--   comparação mora num lugar só e pode melhorar sem reescrever o passado.
--
-- PRIVACIDADE / RETENÇÃO
--   Guarda texto de sugestão (não guarda a mensagem do cliente — essa já vive em `messages`).
--   Sem rosto novo, sem dado sensível novo. A retenção segue a do tenant.
--
-- REVERSÍVEL: a tabela é aditiva e ninguém depende dela para funcionar. Derrubá-la só apaga
-- o aprendizado acumulado; nenhuma tela quebra.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS lead_manager.sugestao_ia (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  conversation_id  uuid,
  lead_id          uuid,
  -- de onde veio o pedido: 'inbox' (botão Sugerir), 'renovacao', 'retomada', 'auto'…
  origem           text NOT NULL,
  -- contexto que o gerador usou ('lead' | 'renovacao' | 'aluno'…), p/ fatiar o aprendizado
  contexto         text,
  -- o texto proposto, como saiu do modelo (depois das travas de identidade/tema)
  texto            text NOT NULL,
  modelo           text,
  -- quem pediu (nome do usuário logado, quando o dashboard manda; NULL = serviço)
  pedida_por       text,
  criada_em        timestamptz NOT NULL DEFAULT now()
);

-- Leitura por conversa e por período é o acesso natural do relatório.
CREATE INDEX IF NOT EXISTS idx_sugestao_ia_tenant_criada
  ON lead_manager.sugestao_ia (tenant_id, criada_em DESC);
CREATE INDEX IF NOT EXISTS idx_sugestao_ia_conversa
  ON lead_manager.sugestao_ia (conversation_id, criada_em DESC);

COMMENT ON TABLE  lead_manager.sugestao_ia IS
  'O que a IA propôs à recepção. O veredito (usou/editou/ignorou) é DERIVADO na leitura por src/aprendizado.js, nunca gravado aqui.';
COMMENT ON COLUMN lead_manager.sugestao_ia.texto IS
  'Texto proposto, já passado pelas travas de identidade e tema — é o que a recepção viu na tela.';

ALTER TABLE lead_manager.sugestao_ia ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.sugestao_ia FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.sugestao_ia;
CREATE POLICY tenant_isolation ON lead_manager.sugestao_ia
  USING      (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''))
  WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''));

-- Só escreve quem gera a sugestão; ninguém edita nem apaga pela aplicação (é registro histórico).
GRANT SELECT, INSERT ON lead_manager.sugestao_ia TO lead_manager_user;

COMMIT;
