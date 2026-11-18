-- ============================================================
-- 193_autoria_da_saida_e_conta_atendido.sql
--
-- DUAS COISAS, E A SEGUNDA SÓ FUNCIONA POR CAUSA DA PRIMEIRA:
--   (1) `staff_outbound_samples.autor_tipo` — QUEM escreveu: 'ia' | 'humano' | 'automacao'.
--   (2) `automacao_config.conta_como_atendido` — se a resposta da IA conta como atendimento.
--
-- ─── POR QUE (1): AUTORIA PELO NOME JÁ FALHOU, E FOI MEDIDO ────────────────────────────────────
--
-- O número do ícone do Regente ("quantos leads ninguém da casa olhou ainda", decisão D1 do Leo em
-- 16/11/2026) decidia "foi gente?" comparando `sender` com o `nome_ia` ATUAL da unidade. A revisão
-- independente mediu em 18/11/2026, em produção, e o `sender` de `source='api'` em Valinhos é:
--
--     SERVICE                          3581     ← o painel do Regente (papel do token)
--     Janis J. (assistente virtual)     417     ← o nome_ia de HOJE  → era excluído, certo
--     Janis J.                           26     ← nome ANTIGO da IA  → contava como PESSOA
--     Rafaela                             7     ← recepcionista      → pessoa, certo
--     Janis Joplin                        6     ← nome ANTIGO da IA  → contava como PESSOA
--     Janis                               5     ← nome ANTIGO da IA  → contava como PESSOA
--
-- Ou seja: **trocar o nome da assistente reescrevia o passado.** 37 respostas da IA passaram a
-- contar como atendimento humano, e o lead saía do ícone sem ninguém ter olhado — exatamente o que
-- a decisão D1 existe para impedir. Nenhum erro aparece: o número fica plausível e errado.
--
-- Nome é rótulo editável; autoria é fato. Esta coluna grava o fato NO MOMENTO DA ESCRITA, e a
-- comparação por nome vira só fallback para o passado (ver o backfill abaixo).
--
-- ⚠ NULLABLE de propósito. Linha antiga que o backfill não conseguir classificar fica NULL, e
--   quem lê trata NULL como "não sei" — nunca como 'humano' por otimismo nem como 'ia' por
--   pessimismo. A régua de leitura está em src/semAtendimentoHumano.js e documenta o fallback.
--
-- ─── POR QUE (2): PEDIDO DO LEO EM 18/11/2026 ──────────────────────────────────────────────────
--
-- "gostaria disso configurável para o caso de um dia termos a agente de IA respondendo os leads
-- interinamente". Hoje a decisão é 'humano' (só gente tira o lead do ícone). Quando a Janis
-- assumir o primeiro atendimento de verdade, a unidade troca para 'humano_ou_ia' e o número passa
-- a significar "ninguém ATENDEU ainda" em vez de "nenhuma PESSOA olhou ainda".
--
-- ⚠ O DEFAULT É 'humano', e isso é a decisão de hoje, não neutralidade. Nasce no comportamento que
--   o Leo escolheu; mudar é um ato explícito da unidade.
--
-- ⚠ MORA EM `automacao_config` porque a contagem JÁ lê essa tabela (pega o `nome_ia` ali). Chave
--   nova em outra tabela custaria uma segunda consulta por aviso — e este caminho roda no momento
--   em que a mensagem do cliente chega.
--
-- Executar como superuser "postgres":
--   psql "$DATABASE_URL" -f db/migrations/193_autoria_da_saida_e_conta_atendido.sql
-- Rollback:
--   ALTER TABLE lead_manager.staff_outbound_samples DROP COLUMN IF EXISTS autor_tipo;
--   ALTER TABLE lead_manager.automacao_config       DROP COLUMN IF EXISTS conta_como_atendido;
-- ============================================================

BEGIN;

-- (1) QUEM ESCREVEU -----------------------------------------------------------------------------
ALTER TABLE lead_manager.staff_outbound_samples
  ADD COLUMN IF NOT EXISTS autor_tipo text;

ALTER TABLE lead_manager.staff_outbound_samples
  DROP CONSTRAINT IF EXISTS staff_outbound_autor_tipo_ck;
ALTER TABLE lead_manager.staff_outbound_samples
  ADD CONSTRAINT staff_outbound_autor_tipo_ck
  CHECK (autor_tipo IS NULL OR autor_tipo IN ('ia', 'humano', 'automacao'));

COMMENT ON COLUMN lead_manager.staff_outbound_samples.autor_tipo IS
  'QUEM escreveu, gravado na hora: ia | humano | automacao. NULL = linha antiga que o backfill da '
  'migr 193 não classificou — quem lê trata como "não sei". Existe porque decidir autoria pelo '
  'NOME (sender x nome_ia) fazia trocar o nome da assistente reescrever o passado: 37 respostas da '
  'IA contavam como atendimento humano. Nome é rótulo editável; autoria é fato.';

-- (2) A CHAVE CONFIGURÁVEL ----------------------------------------------------------------------
ALTER TABLE lead_manager.automacao_config
  ADD COLUMN IF NOT EXISTS conta_como_atendido text NOT NULL DEFAULT 'humano';

ALTER TABLE lead_manager.automacao_config
  DROP CONSTRAINT IF EXISTS automacao_conta_como_atendido_ck;
ALTER TABLE lead_manager.automacao_config
  ADD CONSTRAINT automacao_conta_como_atendido_ck
  CHECK (conta_como_atendido IN ('humano', 'humano_ou_ia'));

COMMENT ON COLUMN lead_manager.automacao_config.conta_como_atendido IS
  'O que tira um lead do número do ícone do Regente. humano = só pessoa (decisão do Leo, '
  '18/11/2026; a resposta da Janis NÃO conta). humano_ou_ia = a resposta da IA também conta, para '
  'quando a assistente assumir o primeiro atendimento. Lido por src/semAtendimentoHumano.js.';

-- BACKFILL --------------------------------------------------------------------------------------
-- Classifica o que dá para classificar SEM CHUTAR. O que sobrar fica NULL e a leitura sabe disso.

-- (a) Fonte é prova direta: 'web'/'android'/'ios'/'desktop' é uma PESSOA digitando no WhatsApp
--     dela (o eco do webhook traz o aparelho). Medido hoje: web 30.786 + android 2.497.
UPDATE lead_manager.staff_outbound_samples
   SET autor_tipo = 'humano'
 WHERE autor_tipo IS NULL
   AND source IN ('web', 'android', 'ios', 'desktop');

-- (b) As automações se identificam pelo nome, e esses nomes são constantes do código
--     (src/boasVindas/auto.js, src/jobs/renovacao-sweep.js) — não texto que alguém edita na tela.
UPDATE lead_manager.staff_outbound_samples
   SET autor_tipo = 'automacao'
 WHERE autor_tipo IS NULL
   AND source = 'api'
   AND sender IN ('boas-vindas-auto', 'renovacao-auto');

-- (c) A IA sob o nome ATUAL da unidade: comparação segura, feita por tenant.
UPDATE lead_manager.staff_outbound_samples s
   SET autor_tipo = 'ia'
 WHERE s.autor_tipo IS NULL
   AND s.source = 'api'
   AND s.sender IS NOT NULL
   AND s.sender = (SELECT ac.nome_ia FROM lead_manager.automacao_config ac
                    WHERE ac.tenant_id = s.tenant_id);

-- (d) ⚠ O CASO QUE DEU ORIGEM A ESTA MIGRAÇÃO, e por isso é explícito e datado: os nomes ANTIGOS
--     da IA. Lista MEDIDA em produção em 18/11/2026, não suposta — 'Janis J.' (26), 'Janis Joplin'
--     (6), 'Janis' (5). São 37 linhas que hoje contam como atendimento humano.
--     Só age onde o nome_ia ATUAL do tenant também começa com 'Janis': sem essa condição, uma
--     unidade futura cuja recepcionista se chame Janis teria a resposta DELA marcada como IA.
--     Esta é uma correção pontual de dado histórico. NÃO é régua: régua é a coluna.
UPDATE lead_manager.staff_outbound_samples s
   SET autor_tipo = 'ia'
 WHERE s.autor_tipo IS NULL
   AND s.source = 'api'
   AND s.sender IN ('Janis J.', 'Janis Joplin', 'Janis')
   AND EXISTS (SELECT 1 FROM lead_manager.automacao_config ac
                WHERE ac.tenant_id = s.tenant_id AND ac.nome_ia LIKE 'Janis%');

-- (e) `historico` (49.276 linhas) fica NULL DE PROPÓSITO. É a importação do histórico do WhatsApp:
--     a escola respondeu, mas não sabemos se foi pessoa ou a IA naquele período. A leitura decide
--     o que fazer com isso, e documenta — aqui, chutar seria inventar autoria para 49 mil linhas.
--     `SERVICE` (3.581) também fica NULL: é o PAPEL DO TOKEN, não autoria (o painel do Regente
--     manda assim). Hoje, na prática, SERVICE = alguém clicando no painel; mas "na prática" não é
--     fato gravado, e a leitura é que assume esse risco, por escrito.

-- Índice: a contagem do ícone filtra por autoria dentro de um NOT EXISTS por contato.
CREATE INDEX IF NOT EXISTS idx_staff_outbound_autor_tipo
    ON lead_manager.staff_outbound_samples (tenant_id, autor_tipo);

COMMIT;

-- Conferência depois de aplicar (quem aplica roda e cola o resultado no RESERVAS):
--   SELECT coalesce(autor_tipo,'(nulo)') AS autor, source, count(*)
--     FROM lead_manager.staff_outbound_samples GROUP BY 1,2 ORDER BY 3 DESC;
--   SELECT conta_como_atendido, count(*) FROM lead_manager.automacao_config GROUP BY 1;
