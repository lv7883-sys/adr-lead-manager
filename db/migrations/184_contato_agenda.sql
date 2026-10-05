-- ============================================================
-- 184_contato_agenda.sql — AGENDA DA UNIDADE: o nome do contato como NÓS salvamos.
--
-- POR QUE EXISTE (descoberto pelo Leo em 05/10/2026): o nome que a Caixa de Entrada mostra é o
-- `pushName` — o nome que a PRÓPRIA PESSOA escreveu no WhatsApp dela. A unidade não tinha onde
-- registrar como ELA chama aquele contato. Medido em Valinhos: 2.136 conversas diretas, 1.303 com
-- pushName, 757 mostrando só o número.
--
-- ⚠ POR QUE NÃO BASTAVA "inverter a precedência para o cadastro": a precedência do pushName acima
-- do cadastro é DELIBERADA (comentário em inbox.js, régua agora em src/contato-nome.js) — o
-- cadastro traz o nome do ALUNO e quem fala no WhatsApp é o PAI/RESPONSÁVEL. Trocar a ordem
-- reintroduziria o defeito que aquela ordem corrigiu. Esta tabela é uma fonte NOVA, acima das duas,
-- e é a única que a unidade escreve de propósito.
--
-- ⚠ POR QUE NÃO É `known_contacts` (migr 004): aquela é o PORTÃO 0 da triagem — diz se um telefone
-- NÃO é lead (STAFF/STUDENT/SUPPLIER) e não tem coluna de nome. Está vazia e não é lida por
-- ninguém em src/ desde sempre; continua intocada aqui. Esta tabela responde outra pergunta:
-- "como a unidade chama este contato". Não fundir as duas.
--
-- CHAVE = `coalesce(nullif(br_phone_key(external_id),''), external_id)`, calculada SEMPRE pelo
-- banco (nunca pela aplicação) para ser uma régua só. Cobre os dois mundos de [[jid-nao-e-telefone]]:
-- telefone casa por br_phone_key (migr 085) e vale para qualquer formato do mesmo número; @lid e
-- outros jids sem telefone casam pelo external_id cru. Em Valinhos: 1.811 jids de telefone, 725 @lid.
--
-- Executar como superuser "postgres":
--   psql "$DATABASE_URL" -f db/migrations/184_contato_agenda.sql
-- Rollback:
--   DROP TABLE IF EXISTS lead_manager.contato_agenda;
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.contato_agenda (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    chave         text NOT NULL,          -- br_phone_key OU external_id cru (ver cabeçalho)
    nome          text NOT NULL,          -- como a UNIDADE chama este contato
    origem        text NOT NULL DEFAULT 'recepcao'
                  CHECK (origem IN ('recepcao', 'importacao', 'extranet')),
    -- Quem salvou. Texto livre porque é o mesmo identificador frouxo que o resto do inbox usa
    -- (?usuario=), não um FK para account_member. Serve para a recepção saber de quem foi o nome,
    -- NÃO para controle: qualquer recepcionista pode editar o nome de qualquer contato (decisão do
    -- Leo, 05/10/2026). Ver [[medicao-declara-unidade-e-autoria]]: autoria frouxa não vira auditoria.
    salvo_por     text,
    criado_em     timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT contato_agenda_nome_nao_vazio CHECK (btrim(nome) <> ''),
    CONSTRAINT contato_agenda_chave_nao_vazia CHECK (btrim(chave) <> ''),
    UNIQUE (tenant_id, chave)
);

COMMENT ON TABLE lead_manager.contato_agenda IS
  'Agenda da unidade: o nome do contato como NÓS salvamos. Prioridade MÁXIMA na exibição do nome '
  '(acima de pushName, cadastro e lead) — régua única em src/contato-nome.js. A chave é '
  'coalesce(nullif(br_phone_key(external_id),""), external_id), calculada pelo banco.';
COMMENT ON COLUMN lead_manager.contato_agenda.origem IS
  'recepcao = digitado na Caixa de Entrada; importacao = carga de agenda (vCard/Google Contatos); '
  'extranet = vindo do cadastro da franqueadora. A origem NÃO muda a prioridade: todas ganham do pushName.';

ALTER TABLE lead_manager.contato_agenda ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.contato_agenda FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.contato_agenda;
CREATE POLICY tenant_isolation ON lead_manager.contato_agenda
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- O DELETE é necessário: apagar o nome salvo devolve a conversa ao pushName (desfazer de verdade,
-- não um nome vazio que esconderia o pushName). Sem UPDATE não haveria "corrigir o que digitei".
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.contato_agenda TO lead_manager_user;

-- Lembrete contra o tombo do privilégio (incidente da migr 177, campanha_alvo): a tabela nasce com
-- GRANT porque o LM roda como lead_manager_user, NÃO como postgres. Teste que prova:
-- test/contato-agenda-privilegio.itest.js roda sob a ROLE restrita.
