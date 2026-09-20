-- ============================================================================
-- 171 — origem_lead: a ORIGEM do contato, gravada no instante em que ela chega.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 171_origem_lead.sql
--   (aplicar DEPOIS da 170_mapa_campanha.sql; não há FK entre elas, só ordem de leitura)
--
-- POR QUÊ
--   O dado de origem de um anúncio Click-to-WhatsApp chega UMA ÚNICA VEZ: no contextInfo
--   da PRIMEIRA mensagem da conversa. Não dá para reconstruir depois — sem acesso ao Meta
--   Business Manager não há Graph API, Insights nem Conversions para perguntar de novo.
--   Por isso a gravação aqui acontece ANTES de qualquer chamada de IA no webhook: se o
--   classificador cair, a conversa espera; a origem, não — ela se perde para sempre.
--
-- UMA LINHA POR CONTATO, NÃO POR MENSAGEM
--   A chave do primeiro toque é (tenant_id, canal, chave_contato), com chave_contato =
--   br_phone_key(telefone) — a MESMA régua de telefone do resto do sistema (migr. 085),
--   que ignora DDI e 9º dígito. O INSERT usa ON CONFLICT DO NOTHING: a segunda mensagem do
--   mesmo contato não sobrescreve nada, nem quando traz outro anúncio.
--
-- POR QUE lead_id É NULO NO COMEÇO
--   Quando a primeira mensagem chega, o lead AINDA NÃO EXISTE: ele nasce depois dos portões
--   de triagem (engine.processInbound), e pode nem nascer. Esperar o lead para gravar a
--   origem seria exatamente o que este arquivo existe para impedir. Então gravamos por
--   contato e ligamos o lead_id assim que ele aparece (leadSource.vincularLead), sem nunca
--   tocar nos campos de origem. O "UNIQUE por lead_id" pedido continua valendo: índice
--   parcial único, um lead nunca tem duas origens.
--
-- IMUTABILIDADE
--   Gatilho BEFORE UPDATE: só lead_id (e atualizado_em) podem mudar. Qualquer tentativa de
--   reescrever anuncio_id, codigo_campanha, metodo, payload_bruto… levanta exceção.
--   Mesma doutrina da origem first-touch da migr. 043 — agora com trava no banco.
--
-- ⚠ payload_bruto guarda o payload BRUTO do webhook, inclusive de quem não virou lead. É o
--   material forense para descobrir formatos de contextInfo que ainda não conhecemos.
--   Contém telefone e o texto da mensagem — nada além do que `messages.raw` já guarda.
--   LGPD: /forget e a retenção (src/anonymize.js) apagam telefone, payload bruto e o texto
--   do anúncio (url/título/corpo). SOBREVIVEM apenas nove campos, nenhum deles capaz de
--   identificar alguém: anuncio_id, codigo_campanha, campanha_ref, motor, objetivo,
--   publico, criativo, metodo, capturado_em. Esquecer uma pessoa não pode reescrever
--   quantos leads aquela campanha trouxe naquele mês.
--
-- Idempotente. RLS por tenant_id, igual ao resto do schema.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS lead_manager.origem_lead (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  -- lead apagado (retenção/LGPD) não pode levar a origem junto nem travar o DELETE:
  -- o vínculo se desfaz, a linha de origem sobrevive e pode religar num lead futuro.
  lead_id        uuid REFERENCES lead_manager.leads(id) ON DELETE SET NULL,
  canal          text NOT NULL DEFAULT 'whatsapp',
  telefone       text NOT NULL,                 -- como o webhook mandou (forense)
  chave_contato  text GENERATED ALWAYS AS (lead_manager.br_phone_key(telefone)) STORED,

  -- via contextInfo.externalAdReply (o que a Meta manda no 1º contato)
  anuncio_id      text,
  anuncio_url     text,
  anuncio_titulo  text,
  anuncio_texto   text,

  -- via código no texto pré-preenchido do anúncio ("… [RK3]")
  codigo_campanha text,

  -- derivados do de-para (mapa_campanha). Cópia CONGELADA: o de-para pode ser corrigido
  -- amanhã, mas o que este lead viu no dia do clique não muda.
  campanha_ref   text,
  motor          text,
  objetivo       text,
  publico        text,
  criativo       text,

  metodo         text NOT NULL
                 CHECK (metodo IN ('anuncio_meta', 'codigo_campanha', 'manual', 'nenhum')),
  payload_bruto  jsonb NOT NULL DEFAULT '{}'::jsonb,
  capturado_em   timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);

-- PRIMEIRO TOQUE: uma linha por contato. É esta restrição que faz o "não sobrescrever"
-- ser uma garantia do banco, e não uma promessa do código da aplicação.
-- A linha ANONIMIZADA (LGPD) sai do índice: duas pessoas esquecidas não podem colidir
-- entre si, e quem escrever de novo depois do esquecimento começa um 1º toque novo —
-- que é exatamente o que "esquecer" significa. O ON CONFLICT do INSERT repete este
-- predicado (inferência de índice parcial); mudar um dos dois exige mudar o outro.
CREATE UNIQUE INDEX IF NOT EXISTS uq_origem_lead_contato
  ON lead_manager.origem_lead (tenant_id, canal, chave_contato)
  WHERE telefone NOT LIKE 'anonimizado\_%';
-- "UNIQUE por lead_id": um lead nunca tem duas origens (linhas ainda sem lead não contam).
CREATE UNIQUE INDEX IF NOT EXISTS uq_origem_lead_lead
  ON lead_manager.origem_lead (tenant_id, lead_id) WHERE lead_id IS NOT NULL;
-- leitura da mídia paga: "quantos leads vieram da campanha X?"
CREATE INDEX IF NOT EXISTS idx_origem_lead_campanha
  ON lead_manager.origem_lead (tenant_id, campanha_ref, capturado_em) WHERE campanha_ref IS NOT NULL;
-- forense: "o que chegou sem casar?" (é aqui que se descobre formato novo)
CREATE INDEX IF NOT EXISTS idx_origem_lead_metodo
  ON lead_manager.origem_lead (tenant_id, metodo, capturado_em);

-- ── Imutabilidade da origem ────────────────────────────────────────────────────────────
-- Só o vínculo com o lead pode mudar depois da gravação.
CREATE OR REPLACE FUNCTION lead_manager.origem_lead_imutavel()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  anonimizando boolean;
BEGIN
  -- EXCEÇÃO ÚNICA: anonimização (LGPD, src/anonymize.js). Nove campos sobrevivem à
  -- exclusão, e SÓ eles — são os que respondem "de qual anúncio veio", e nenhum deles
  -- identifica ninguém:
  --   anuncio_id, codigo_campanha, campanha_ref, motor, objetivo, publico, criativo,
  --   metodo, capturado_em
  -- Tudo que pode carregar pessoa é APAGADO: telefone (vira sentinela), payload_bruto
  -- (o webhook inteiro: telefone, nome de perfil, texto da mensagem) e também
  -- anuncio_url / anuncio_titulo / anuncio_texto — a URL costuma trazer parâmetros de
  -- rastreio, e título e corpo do anúncio são reconstituíveis a partir de anuncio_id.
  -- Nada disso faz falta para a leitura da mídia paga; esquecer uma pessoa não pode
  -- reescrever quantos leads aquela campanha trouxe naquele mês.
  anonimizando := NEW.telefone LIKE 'anonimizado\_%'
              AND NEW.payload_bruto = '{}'::jsonb
              AND NEW.anuncio_url IS NULL
              AND NEW.anuncio_titulo IS NULL
              AND NEW.anuncio_texto IS NULL
              AND OLD.telefone NOT LIKE 'anonimizado\_%';

  IF (NEW.tenant_id, NEW.canal, NEW.anuncio_id, NEW.codigo_campanha, NEW.campanha_ref,
      NEW.motor, NEW.objetivo, NEW.publico, NEW.criativo, NEW.metodo, NEW.capturado_em)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.canal, OLD.anuncio_id, OLD.codigo_campanha, OLD.campanha_ref,
      OLD.motor, OLD.objetivo, OLD.publico, OLD.criativo, OLD.metodo, OLD.capturado_em)
     OR (NOT anonimizando
         AND (NEW.telefone, NEW.payload_bruto, NEW.anuncio_url, NEW.anuncio_titulo, NEW.anuncio_texto)
             IS DISTINCT FROM
             (OLD.telefone, OLD.payload_bruto, OLD.anuncio_url, OLD.anuncio_titulo, OLD.anuncio_texto))
  THEN
    RAISE EXCEPTION 'origem_lead é imutável: só lead_id muda (e a anonimização apaga o que identifica a pessoa) — linha %', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_origem_lead_imutavel ON lead_manager.origem_lead;
CREATE TRIGGER trg_origem_lead_imutavel
  BEFORE UPDATE ON lead_manager.origem_lead
  FOR EACH ROW EXECUTE FUNCTION lead_manager.origem_lead_imutavel();

ALTER TABLE lead_manager.origem_lead ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.origem_lead FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.origem_lead;
CREATE POLICY tenant_isolation ON lead_manager.origem_lead
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Sem DELETE: origem não se apaga pela aplicação (a faxina de retenção roda como superuser).
-- E o UPDATE é por COLUNA: a aplicação só escreve lead_id (o vínculo) e, na anonimização,
-- o que identifica a pessoa (apagar PII). Um UPDATE errado em campanha/anúncio é recusado
-- pelo banco ANTES mesmo do gatilho — cinto e suspensório.
GRANT SELECT, INSERT ON lead_manager.origem_lead TO lead_manager_user;
-- UPDATE por COLUNA: a aplicação escreve o vínculo do lead e, na exclusão LGPD, só o
-- que identifica a pessoa. Campanha, anúncio e método são recusados pelo BANCO antes
-- mesmo do gatilho.
GRANT UPDATE (lead_id, telefone, payload_bruto, anuncio_url, anuncio_titulo, anuncio_texto)
  ON lead_manager.origem_lead TO lead_manager_user;

COMMENT ON TABLE lead_manager.origem_lead IS
  'Origem do 1º toque por contato (Click-to-WhatsApp). Gravada ANTES da IA no webhook; imutável exceto lead_id.';
COMMENT ON COLUMN lead_manager.origem_lead.payload_bruto IS
  'Payload bruto do webhook da 1ª mensagem — inclusive quando metodo=none (forense de formatos novos).';

COMMIT;

-- ROLLBACK:
--   DROP TABLE IF EXISTS lead_manager.origem_lead;
--   DROP FUNCTION IF EXISTS lead_manager.origem_lead_imutavel();
