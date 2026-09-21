-- 20-plataforma-base.sql — roda no banco `lm_plataforma`.
--
-- O schema `app` mínimo, do Scheduler: é dele que sai hoje a resposta para
-- "esta unidade contratou este módulo?" (fonte única futura = plataforma.assinatura,
-- ADR-051 D9). `app.franquia.lead_tenant_id` (migr. 063 de lá) é a ponte entre o id
-- de franquia e o uuid da unidade no Lead Manager.
--
-- SEM RLS, igual a produção: o schema `app` não usa RLS, e por isso o filtro por
-- unidade em `src/plataforma/licenca.js` é explícito e obrigatório. Reproduzir isso
-- aqui é o que faz o teste valer.

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.franquia (
  id             serial PRIMARY KEY,
  slug           text UNIQUE NOT NULL,
  nome           text NOT NULL,
  lead_tenant_id uuid
);

CREATE TABLE IF NOT EXISTS app.tenant_modules (
  franquia_id   int  NOT NULL REFERENCES app.franquia(id) ON DELETE CASCADE,
  module        text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  activated_at  timestamptz NOT NULL DEFAULT now(),
  activated_by  text,
  PRIMARY KEY (franquia_id, module)
);
