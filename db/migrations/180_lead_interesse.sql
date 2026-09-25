-- ============================================================================
-- 180_lead_interesse.sql — INTERESSE por BENEFICIÁRIO (passo 1 do modelo contato↔oportunidade).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 180_....sql
--
-- O QUE O LEO DESCREVEU
--   "A Pessoa 1 tem interesse no Instrumento 1 para ela mesma; e no Instrumento 2 também para ela;
--   e num instrumento para a Pessoa 2 (filho, amigo, parente); e num segundo instrumento para a
--   Pessoa 2; e em instrumentos para as Pessoas 3, 4, N." Cinco interesses, um telefone.
--
-- O QUE O MODELO DE HOJE AGUENTA: UM. Medido: 748 telefones com lead, ZERO com mais de um
--   (uq_leads_tenant_phone), e `leads` só tem `name` e `phone` — não existe "para quem" nem
--   instrumento estruturado. A segunda pergunta da mesma mãe sobrescreve a primeira ou se perde.
--   Universo que isto desambigua: 42 responsáveis com 2+ beneficiários distintos, 27 deles com
--   lead no LM. (⚠ NÃO são 213 — aquele número contava CONTRATOS, e contrato inclui renovação do
--   mesmo aluno. Erro corrigido em 25/09 antes de virar decisão.)
--
-- ⚠ REGRA DO LEO QUE MANDA NESTA MIGRAÇÃO (25/09), nas palavras dele:
--   "hoje a identificação de leads já funciona muito bem, com o gate, IA, etc. e isso não pode em
--   hipótese nenhuma se perder. O que vamos fazer é uma melhoria ON TOP do que já temos."
--   Em consequência, e sem exceção:
--     • esta tabela fica AO LADO do pipeline, nunca no meio dele. Gate, classificador, régua de
--       etapa e fila de revisão NÃO a leem e NÃO mudam;
--     • o FUNIL CONTINUA CONTANDO COMO CONTA HOJE — por LEAD. Esta tabela **não é fonte de
--       contagem** do funil nem da taxa de conversão. Trocar a unidade é o passo 3, não aprovado:
--       o denominador cresceria e a taxa cairia, e o Leo quer medir antes;
--     • SEM coluna de estado/etapa aqui, de propósito — estado é o que muda número;
--     • se algum trabalho futuro exigir alterar o pipeline atual por causa desta tabela, PARA e
--       PERGUNTA em vez de adaptar.
--   Régua de sucesso do passo 1: *o que funciona hoje continua idêntico, e passamos a guardar o
--   que antes se perdia*.
--
-- DESENHO
--   lead_id            = quem FALOU (o contato). Continua sendo o dono do telefone e do card.
--   para_si            = o interesse é do próprio contato (o caso mais comum).
--   beneficiario_nome  = para quem é, quando não é para si. TEXTO — criança de 7 anos não tem
--                        telefone nem cadastro; o beneficiário nasce PROVISÓRIO e assim fica até
--                        virar contrato.
--   beneficiario_person_id = identidade real, só quando existir contrato. ⚠ NUNCA casar por NOME
--                        PURO: "Massa", "IG" e "mafe" são nomes reais nesta base e há dois leads
--                        distintos chamados "Carolina". O casamento provisório→real exige contrato
--                        do MESMO contato e fica marcado como inferido (`beneficiario_inferido`),
--                        revisável por gente. Id errado é pior que id nenhum.
--   curso              = pode ser NULL: a Extranet aceita ficha sem curso, e inventar é pior.
--
-- POR QUE NASCE QUASE POPULADA: a Extranet JÁ MODELA interesse por ficha (nome + curso próprios).
--   215 fichas de interesse, 23 telefones com 2+ fichas. A Simone Bassi Armani tem duas (Canto
--   realizada + Piano cancelada) — dois interesses da mesma pessoa, já separados na origem. O
--   populamento roda FORA do sync (job próprio), justamente para não tocar no pipeline.
--
-- ⚠ `beneficiario_person_id` É A 11ª COLUNA DO MAPA DE FUSÃO DE PESSOAS (achado da frente de
--   qualidade, 25/09). Já existem 10 colunas com id de pessoa espalhadas (1.819 linhas), e o
--   acordo com o Rock Hour é que fusão de ficha exige mapa `id_antigo → id_novo`, repasse
--   idempotente e conferência de órfão. **Esta coluna nasce JÁ registrada nessa lista** — senão,
--   daqui a dois meses a fusão repassa dez e deixa a décima primeira apontando para o vazio.
--   A favor desta: é a única com FK DE VERDADE, então o banco reclama; as outras somem caladas.
--
-- ⚠ COMO DECIDIR `para_si` — a assimetria importa mais que a acurácia:
--     errar para FALSE (dizer que é para outra pessoa quando é a mesma) → cria um beneficiário
--       fantasma: visível, revisável, reversível;
--     errar para TRUE  (dizer que é para si quando é para outra) → FUNDE DUAS PESSOAS numa só:
--       invisível, e é exatamente o erro que custou a semana.
--   Logo: NA DÚVIDA, `para_si = false`. Comparar nome da ficha com nome do lead é heurística fraca
--   de propósito ("Tom" e "Thomas de Brito Soares" são a mesma pessoa nesta base, e vão cair no
--   lado seguro). Nunca o contrário.
--
-- ⚠ TELEFONE É CANAL, NÃO IDENTIDADE: um telefone serve mãe e filhos. Telefone igual com nome
--   diferente NÃO liga ninguém. E toda consulta que cruzar telefone tem de usar
--   `lead_manager.br_phone_key()` NOS DOIS LADOS — há pelo menos dois formatos gravados no banco
--   (`contact_point.br_key` já canônico vs `leads.phone` em E.164), e comparação ingênua devolve
--   ZERO. Três "zeros falsos" apareceram em 2 dias por isso. Zero redondo é hipótese, não resultado.
--
-- Aditiva. Nada lê esta tabela ainda. Rollback = DROP.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lead_manager.lead_interesse (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  lead_id                uuid NOT NULL REFERENCES lead_manager.leads(id) ON DELETE CASCADE,
  para_si                boolean NOT NULL DEFAULT true,
  beneficiario_nome      text,
  beneficiario_person_id uuid REFERENCES lead_manager.person(id) ON DELETE SET NULL,
  beneficiario_inferido  boolean NOT NULL DEFAULT false,
  curso                  text,
  fonte                  text NOT NULL CHECK (fonte IN ('extranet_lead','conversa','manual')),
  -- RESTRICT, não SET NULL: com SET NULL, apagar uma ficha faria várias linhas ficarem com NULL e
  -- o UNIQUE abaixo deixaria de proteger. O espelho só faz soft-delete (nunca DELETE), então
  -- RESTRICT não custa nada e troca um PRESSUPOSTO por uma GARANTIA — pressuposto é o que falha
  -- calado, e foi a lição da semana.
  extranet_lead_id       uuid REFERENCES lead_manager.extranet_lead(id) ON DELETE RESTRICT,
  primeiro_visto_em      timestamptz NOT NULL DEFAULT now(),
  ultimo_visto_em        timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- coerência: ou é para si (sem nome de beneficiário), ou é para outra pessoa (com nome)
  CONSTRAINT lead_interesse_para_quem CHECK (
    (para_si AND beneficiario_nome IS NULL) OR (NOT para_si AND beneficiario_nome IS NOT NULL)),
  -- 1 ficha da Extranet = 1 interesse (idempotência do populamento)
  UNIQUE (tenant_id, extranet_lead_id)
);

ALTER TABLE lead_manager.lead_interesse OWNER TO lead_manager_user;
ALTER TABLE lead_manager.lead_interesse ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.lead_interesse FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.lead_interesse;
CREATE POLICY tenant_isolation ON lead_manager.lead_interesse
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON lead_manager.lead_interesse TO lead_manager_user;

CREATE INDEX IF NOT EXISTS idx_lead_interesse_lead ON lead_manager.lead_interesse (tenant_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_interesse_pessoa
  ON lead_manager.lead_interesse (tenant_id, beneficiario_person_id) WHERE beneficiario_person_id IS NOT NULL;

COMMENT ON TABLE lead_manager.lead_interesse IS
  'Interesse por BENEFICIARIO (passo 1, 25/09/2026). NAO E FONTE DE CONTAGEM do funil nem da taxa de conversao -- o funil conta por LEAD, como sempre contou. Trocar a unidade e o passo 3 e depende de decisao do Leo. Fica AO LADO do pipeline: gate, classificador e regua de etapa nao a leem. Regra do Leo: melhoria ON TOP, o que funciona hoje continua identico.';
COMMENT ON COLUMN lead_manager.lead_interesse.lead_id IS 'Quem FALOU (o contato dono do telefone) -- nao necessariamente quem vai estudar.';
COMMENT ON COLUMN lead_manager.lead_interesse.beneficiario_nome IS 'Para quem e o interesse, em TEXTO. Provisorio ate virar contrato; crianca nao tem cadastro.';
COMMENT ON COLUMN lead_manager.lead_interesse.beneficiario_person_id IS 'Identidade real, so quando houver contrato do MESMO contato. Nunca casar por nome puro (ha homonimos reais na base). Ver beneficiario_inferido. ATENCAO: e a 11a coluna do mapa de fusao de pessoas -- qualquer fusao de ficha precisa repassar esta tambem.';

-- VIEW do conjunto SEGURO: só vínculos CONFIRMADOS (não inferidos). Quem consumir por descuido
-- pega o conjunto que não chuta; quem quiser o inferido precisa pedir a tabela explicitamente.
CREATE OR REPLACE VIEW lead_manager.v_lead_interesse_confirmado AS
SELECT * FROM lead_manager.lead_interesse WHERE NOT beneficiario_inferido;
GRANT SELECT ON lead_manager.v_lead_interesse_confirmado TO lead_manager_user;
COMMENT ON VIEW lead_manager.v_lead_interesse_confirmado IS
  'Interesses com beneficiario CONFIRMADO (nao inferido). Use esta por padrao; a tabela crua inclui vinculos inferidos, que sao palpite revisavel.';

-- ---- VERIFICAÇÃO -----------------------------------------------------------------------------
-- Nasce VAZIA e ninguém a lê. O funil, o gate e a classificação devem ficar byte-a-byte iguais:
--   SELECT count(*) FROM lead_manager.lead_interesse;            -- 0
-- Depois do populamento (job próprio, fora do sync), o esperado a partir das fichas da Extranet:
--   SELECT fonte, count(*), count(DISTINCT lead_id) FROM lead_manager.lead_interesse GROUP BY 1;
--
-- ---- ROLLBACK --------------------------------------------------------------------------------
--   DROP TABLE IF EXISTS lead_manager.lead_interesse;
