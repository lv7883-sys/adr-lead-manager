-- ============================================================
-- 192_ingestao_latencia.sql — O RELÓGIO DA ENTRADA: quanto tempo passa entre a mensagem
-- chegar e o lead existir.
--
-- POR QUE EXISTE (decisão do Leo, 16/11/2026). O pedido é um aviso "no instante em que o lead
-- chega" (ver docs/proposta-aviso-lead-novo.md, D2). Ao desenhar isso ficou claro que a maior
-- parte da espera NÃO está no jeito de avisar: o lead só nasce DEPOIS de a IA classificar a
-- mensagem (`captureForReview` recebe a classificação como argumento, src/engine.js:528). Em
-- áudio são duas chamadas de IA — transcrever e classificar.
--
-- ⚠ E NINGUÉM MEDIA ISSO. Até esta migração não havia UM registro de duração em src/gemini.js
-- nem em src/engine.js. Qualquer promessa de "x segundos" para a recepção seria chute. Esta
-- tabela existe para transformar "é rápido" num número que a gente defende — e a decisão
-- seguinte (avisar certo e alguns segundos depois, ou avisar em ~1s e corrigir o aviso na tela)
-- DEPENDE desse número.
--
-- ⚠ POR QUE TABELA E NÃO LINHA DE LOG. O log deste projeto é a saída do contêiner: some no
-- deploy. Já aconteceu — dois deploys apagaram os registros de 13/10 no meio de uma
-- investigação. Uma medição que precisa de alguns dias de coleta não pode morar lá. A linha de
-- log continua existindo (serve para olhar agora); a tabela é o que sobrevive até a leitura.
--
-- ⚠ O QUE ELA DELIBERADAMENTE NÃO GUARDA: telefone, nome, texto da mensagem. Isto é um
-- cronômetro, não um espelho da conversa — e dado pessoal que não é preciso não deve existir.
-- O `external_message_id` fica porque sem ele é impossível investigar um caso de 40 s (é o id
-- da mensagem no WhatsApp, já presente em messages/staff_outbound_samples).
--
-- ⚠ `fila_ms` PODE SER NEGATIVO, e isso não é defeito: ele compara o relógio do WhatsApp
-- (`messageTimestamp`, em segundos) com o relógio do nosso servidor. Relógios diferentes
-- discordam. Negativo ou absurdo = desvio de relógio, e a leitura descarta esses casos em vez
-- de fingir que mediu. Por isso não há CHECK de positividade aqui: a trava mentiria sobre o que
-- o dado é.
--
-- VIDA ÚTIL: isto é instrumento de medição, não dado de produto. Depois da decisão, ou vira
-- dado permanente de saúde da ingestão (e aí ganha dono e retenção), ou é apagada. Não deixar
-- apodrecer sem dono.
--
-- Executar como superuser "postgres":
--   psql "$DATABASE_URL" -f db/migrations/192_ingestao_latencia.sql
-- Rollback:
--   DROP TABLE IF EXISTS lead_manager.ingestao_latencia;
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.ingestao_latencia (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    -- id da mensagem no WhatsApp. Serve para investigar um caso lento e para não contar duas
    -- vezes o mesmo eco. Nullable: nem todo evento traz id.
    external_message_id text,
    canal               text NOT NULL DEFAULT 'whatsapp',

    -- MARCOS
    recebido_em         timestamptz NOT NULL,   -- T0: o webhook entrou no Lead Manager
    enviado_em          timestamptz,            -- o que o WhatsApp diz que foi o envio (pode discordar do nosso relógio)

    -- FASES, em milissegundos. A soma das fases é <= total_ms (sobra o que não foi cronometrado).
    fila_ms             integer,   -- recebido_em - enviado_em: Evolution + despachante. VER o aviso de relógio acima
    origem_ms           integer,   -- gravar a origem do anúncio (só banco)
    midia_ms            integer,   -- baixar mídia e, em áudio, transcrever com a IA
    funil_ms            integer,   -- engine.processInbound: classificação da IA + criação do lead + aviso
    total_ms            integer NOT NULL,   -- T0 até o fim do funil. É ESTE o número do "no instante"

    -- CONTEXTO (o mínimo para ler a distribuição sem adivinhar)
    tem_midia           boolean NOT NULL DEFAULT false,
    tipo_midia          text,               -- audio | image | video | document | null
    -- O desfecho desta mensagem para o funil. `lead_novo` é a linha que importa para o aviso:
    -- é o caso em que existe algo a notificar.
    lead_existe         boolean NOT NULL DEFAULT false,
    lead_novo           boolean NOT NULL DEFAULT false,

    criado_em           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE lead_manager.ingestao_latencia IS
  'Cronômetro da entrada (16/11/2026): quanto tempo entre o webhook chegar e o lead existir. '
  'Instrumento de medição com prazo de validade — ver o cabeçalho da migração 192. '
  'Leitura: node scripts/latencia-ingestao.js';
COMMENT ON COLUMN lead_manager.ingestao_latencia.fila_ms IS
  'Pode ser negativo: compara o relógio do WhatsApp com o nosso. Negativo/absurdo = desvio de relógio, '
  'e a leitura descarta em vez de fingir que mediu.';
COMMENT ON COLUMN lead_manager.ingestao_latencia.total_ms IS
  'O número que responde "no instante?" — T0 (webhook) até o fim de processInbound, que é depois '
  'do aviso de lead novo ser disparado.';

-- A leitura é sempre "últimos N dias desta unidade".
CREATE INDEX IF NOT EXISTS idx_ingestao_latencia_tenant_recebido
    ON lead_manager.ingestao_latencia (tenant_id, recebido_em DESC);
-- A pergunta que decide o desenho é só sobre as mensagens que VIRARAM lead novo.
CREATE INDEX IF NOT EXISTS idx_ingestao_latencia_lead_novo
    ON lead_manager.ingestao_latencia (tenant_id, recebido_em DESC)
    WHERE lead_novo;

ALTER TABLE lead_manager.ingestao_latencia ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.ingestao_latencia FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.ingestao_latencia;
CREATE POLICY tenant_isolation ON lead_manager.ingestao_latencia
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Lembrete contra o tombo do privilégio (incidente da migr 177, campanha_alvo): o LM roda como
-- lead_manager_user, NÃO como postgres. Sem este GRANT a tabela nasce invisível para a aplicação
-- e o cronômetro registraria zero linhas em silêncio — que é exatamente o modo de falha que esta
-- medição não pode ter (ausência de erro não é prova; a prova é linha gravada).
-- Sem UPDATE e sem DELETE de propósito: medição não se corrige depois.
GRANT SELECT, INSERT ON lead_manager.ingestao_latencia TO lead_manager_user;
