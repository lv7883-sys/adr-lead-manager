-- 00-role-e-bancos.sql — roda no banco `postgres` do container de teste.
--
-- Cria o papel da APLICAÇÃO (não superusuário) e os dois bancos descartáveis.
-- O papel não ser superusuário é o ponto todo: superusuário ignora RLS, e um teste
-- de isolamento rodado como superusuário não prova absolutamente nada.
--
-- Idempotente: pode rodar de novo sem sujeira.

DROP DATABASE IF EXISTS lm_origem;
DROP DATABASE IF EXISTS lm_plataforma;
DROP ROLE IF EXISTS lead_manager_user;

CREATE ROLE lead_manager_user LOGIN PASSWORD 'itest';
ALTER ROLE lead_manager_user SET search_path = lead_manager, public;

CREATE DATABASE lm_origem     OWNER postgres;
CREATE DATABASE lm_plataforma OWNER postgres;
