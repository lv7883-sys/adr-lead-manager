-- ============================================================
-- ADR-037 (emenda 2026-07-21, ponto b/f) — TIPO do telefone no cadastro-mestre.
-- ADITIVA e não-destrutiva: só adiciona lead_manager.contact_point.tipo (nullable) para
-- distinguir o telefone de CADASTRO (digitado na Extranet, registro formal) do de WHATSAPP
-- (número efetivo de contato) — dois números possivelmente diferentes da mesma pessoa.
-- Prepara o TERRENO; o endpoint /cadastro/contratos AINDA NÃO preenche este campo (dívida
-- pós-backfill, quando a ficha do aluno trouxer os números por tipo). NÃO altera RLS/posse/
-- policies (a coluna herda tudo) nem unicidade (contact_point não tem UNIQUE — o DB já
-- permite 2+ telefones/pessoa com tipos distintos; a idempotência é só no app).
--
-- Backfill dos existentes: TODOS os contact_point atuais vêm da Extranet (source='extranet',
-- confidence='alegado') = CADASTRO — daí o default derivado da fonte (não 'whatsapp').
--
-- Migrations manuais, sem runner (NUNCA db push):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 067_contact_point_tipo.sql
-- ============================================================

ALTER TABLE lead_manager.contact_point
  ADD COLUMN IF NOT EXISTS tipo text;   -- 'cadastro' | 'whatsapp' | 'outro' | NULL (desconhecido)

COMMENT ON COLUMN lead_manager.contact_point.tipo IS
  'Tipo do contato p/ os consumidores: cadastro (registro formal, ex. Extranet) vs whatsapp (número efetivo de contato) vs outro. NULL = ainda não classificado. Ortogonal a source/confidence.';

-- CHECK idempotente (permite NULL + os 3 valores previstos).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_point_tipo_check') THEN
    ALTER TABLE lead_manager.contact_point
      ADD CONSTRAINT contact_point_tipo_check
      CHECK (tipo IS NULL OR tipo IN ('cadastro','whatsapp','outro'));
  END IF;
END $$;

-- Backfill derivado da FONTE (idempotente: só toca linhas ainda sem tipo).
UPDATE lead_manager.contact_point
   SET tipo = CASE
                WHEN source IN ('extranet','api_extranet','native') THEN 'cadastro'
                WHEN source IN ('whatsapp','conversa')              THEN 'whatsapp'
                ELSE 'outro'
              END
 WHERE tipo IS NULL;

-- ROLLBACK (manual, não-destrutivo):
--   ALTER TABLE lead_manager.contact_point DROP CONSTRAINT IF EXISTS contact_point_tipo_check;
--   ALTER TABLE lead_manager.contact_point DROP COLUMN IF EXISTS tipo;
