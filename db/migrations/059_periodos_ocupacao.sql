-- ============================================================
-- ADR-032 — Períodos de ocupação configuráveis por tenant.
-- Faixas de período (manhã/tarde/noite/sábado…) usadas pelo dashboard de
-- ocupação (Bloco B) como DENOMINADOR por janela ativa (não o dia cru 09-21,
-- que mistura pico com hora morta). Config-as-data por tenant — nomes de
-- período são chaves livres; cada período = faixa de hora + dias a que se aplica.
-- Estrutura jsonb:
--   { "manha":{"faixa":["09:00","12:00"],"dias":[1,2,3,4,5]}, ... }
--   - faixa = ["HH:MM","HH:MM") fim exclusivo; dias = ISO 1=seg..7=dom.
-- ADITIVA: coluna nullable, NÃO toca dado existente (rollback = dropar a coluna).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 059_periodos_ocupacao.sql
-- ============================================================

ALTER TABLE lead_manager.tenants
  ADD COLUMN IF NOT EXISTS periodos_ocupacao jsonb;

-- Seed Valinhos (só se ainda não tiver): manhã 09-12 / tarde 12-18 / noite 18-21
-- (seg-sex) + sábado 09-13 (dia 6). Outros tenants definem os seus pela tela.
UPDATE lead_manager.tenants
   SET periodos_ocupacao = '{
     "manha":  {"faixa":["09:00","12:00"], "dias":[1,2,3,4,5]},
     "tarde":  {"faixa":["12:00","18:00"], "dias":[1,2,3,4,5]},
     "noite":  {"faixa":["18:00","21:00"], "dias":[1,2,3,4,5]},
     "sabado": {"faixa":["09:00","13:00"], "dias":[6]}
   }'::jsonb
 WHERE id = 'ed731a58-62e5-45ad-acba-a5502ff39e92'
   AND periodos_ocupacao IS NULL;
