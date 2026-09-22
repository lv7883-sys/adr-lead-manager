# Makefile — migrações e testes do Lead Manager / núcleo de plataforma.
#
#   make test            testes puros (offline, sem banco, sem rede)
#   make test-db-up      sobe o Postgres descartável (porta 5433, tmpfs)
#   make test-isolation  migra e roda a suíte BLOQUEANTE de isolamento entre unidades
#   make test-origem     migra e roda a suíte da origem do lead
#   make test-db-down    derruba e apaga o banco de teste
#   make test-all        sobe, roda tudo, derruba — MESMO se algum teste falhar
#   make ci              é isto que o build roda
#   make ingest-status   painel READ-ONLY da ingestão de mídia (roda NA VPS, no container)
#
# MSYS_NO_PATHCONV=1 em todo comando docker: no Git Bash do Windows, um argumento
# que começa com "/" (ex.: /var/lib/postgresql/data) é traduzido para caminho do
# Windows antes de chegar ao docker, e o comando quebra de um jeito difícil de ler.
#
# NUNCA aponte PSQL_DSN para produção: `migrate` aplica DDL. O alvo
# `guard-nao-producao` recusa DSN que não seja local, para isso não acontecer por
# distração. O banco de teste é outro (porta 5433, em memória, some no down).
#
SHELL := /bin/bash

# -p adr-lm-teste: nome de projeto explícito, além do `name:` no arquivo (versões antigas
# do compose ignoram o `name:`). É o que impede este Makefile de enxergar — e mexer em —
# containers do compose de PRODUÇÃO, que na VPS mora na mesma pasta.
DC        := MSYS_NO_PATHCONV=1 docker compose -p adr-lm-teste -f docker-compose.test.yml
PSQL      := MSYS_NO_PATHCONV=1 docker compose -p adr-lm-teste -f docker-compose.test.yml exec -T pg-teste psql -v ON_ERROR_STOP=1 -q -U postgres
PORTA     := 5433

DSN_ORIGEM     := postgres://lead_manager_user:itest@127.0.0.1:$(PORTA)/lm_origem
ADM_ORIGEM     := postgres://postgres:itest@127.0.0.1:$(PORTA)/lm_origem
DSN_PLATAFORMA := postgres://lead_manager_user:itest@127.0.0.1:$(PORTA)/lm_plataforma
ADM_PLATAFORMA := postgres://postgres:itest@127.0.0.1:$(PORTA)/lm_plataforma

# Migrações desta frente (para `make migrate`, que é para banco local à mão).
MIGRATIONS ?= 172_plataforma_nucleo 173_marketing_nucleo 175_marketing_ingestao
GRANTS     ?= plataforma_contratacao_read
PSQL_DSN   ?= $(ADM_PLATAFORMA)

# Testes puros: rodam offline e não tocam em banco nenhum.
UNIT_TESTS := test/plataforma.test.js test/origem-lead.test.js test/ia-wrapper.test.js \
              test/sdk-ia-sem-atalho.test.js test/anonimizacao-ordem-migracao.test.js \
              test/webhook.test.js test/waConteudo.test.js test/ingestao.test.js

.PHONY: test test-db-up test-db-down test-isolation test-origem test-ingestao test-all ci migrate guard-nao-producao ingest-status

# ── testes puros ──────────────────────────────────────────────────────────────
test:
	node --test $(UNIT_TESTS)

# ── banco de teste ────────────────────────────────────────────────────────────
test-db-up:
	@echo "[db] subindo Postgres de teste na porta $(PORTA) (tmpfs, descartável)…"
	@$(DC) up -d
	@for i in $$(seq 1 60); do \
	  if $(DC) exec -T pg-teste pg_isready -U postgres -d postgres >/dev/null 2>&1; then \
	    echo "[db] pronto"; exit 0; \
	  fi; \
	  sleep 1; \
	done; \
	echo "[db] NÃO ficou pronto em 60s"; $(DC) logs --tail 30 pg-teste; exit 1

test-db-down:
	@echo "[db] derrubando e apagando…"
	@# SEM --remove-orphans de propósito: "órfão" é qualquer container do projeto que não
	@# esteja neste arquivo — e um engano de nome de projeto transformaria isso em derrubar
	@# produção. O -v aqui só alcança volumes deste projeto.
	@$(DC) down -v

# ── suíte da ORIGEM DO LEAD (migrações 170/171) ───────────────────────────────
test-origem:
	@echo "[origem] bootstrap + migrações (duas vezes, idempotência)…"
	@$(PSQL) -d postgres   < test/db/00-role-e-bancos.sql
	@$(PSQL) -d lm_origem  < test/db/10-origem-lead-base.sql
	@for r in 1 2; do \
	  for m in 085_br_phone_key 170_mapa_campanha 171_origem_lead 174_origem_lead_privilegios; do \
	    $(PSQL) -d lm_origem < db/migrations/$$m.sql >/dev/null; \
	  done; \
	done
	@echo "[origem] rodando a suíte…"
	@DATABASE_URL="$(DSN_ORIGEM)" ADMIN_DATABASE_URL="$(ADM_ORIGEM)" \
	  node --test --test-concurrency=1 test/origem-lead.itest.js

# ── suíte BLOQUEANTE de isolamento entre unidades (migrações 172/173) ─────────
test-isolation:
	@echo "[isolamento] bootstrap + migrações (duas vezes, idempotência)…"
	@$(PSQL) -d postgres       < test/db/00-role-e-bancos.sql
	@$(PSQL) -d lm_plataforma  < test/db/20-plataforma-base.sql
	@for r in 1 2; do \
	  for m in $(MIGRATIONS); do \
	    $(PSQL) -d lm_plataforma < db/migrations/$$m.sql >/dev/null; \
	  done; \
	  for g in $(GRANTS); do \
	    $(PSQL) -d lm_plataforma < db/grants/$$g.sql >/dev/null; \
	  done; \
	done
	@echo "[isolamento] conferindo RLS ATIVA e FORÇADA em toda tabela nova…"
	@$(PSQL) -d lm_plataforma < test/db/30-confere-rls.sql
	@echo "[isolamento] rodando a suíte…"
	@DATABASE_URL="$(DSN_PLATAFORMA)" ADMIN_DATABASE_URL="$(ADM_PLATAFORMA)" \
	  LM_ENCRYPTION_KEY="chave-de-teste-da-infra" \
	  node --test --test-concurrency=1 test/isolamento-tenant.itest.js

# ── suíte da INGESTÃO DE MÍDIA (migração 175) ─────────────────────────────────
test-ingestao:
	@echo "[ingestao] bootstrap + migrações (duas vezes, idempotência)…"
	@$(PSQL) -d postgres       < test/db/00-role-e-bancos.sql
	@$(PSQL) -d lm_plataforma  < test/db/20-plataforma-base.sql
	@for r in 1 2; do \
	  for m in $(MIGRATIONS); do \
	    $(PSQL) -d lm_plataforma < db/migrations/$$m.sql >/dev/null; \
	  done; \
	  for g in $(GRANTS); do \
	    $(PSQL) -d lm_plataforma < db/grants/$$g.sql >/dev/null; \
	  done; \
	done
	@echo "[ingestao] conferindo RLS ATIVA e FORÇADA em toda tabela nova…"
	@$(PSQL) -d lm_plataforma < test/db/30-confere-rls.sql
	@echo "[ingestao] rodando a suíte…"
	@DATABASE_URL="$(DSN_PLATAFORMA)" ADMIN_DATABASE_URL="$(ADM_PLATAFORMA)" \
	  LM_ENCRYPTION_KEY="chave-de-teste-da-infra" \
	  node --test --test-concurrency=1 test/ingestao.itest.js

# Painel da ingestão. NÃO roda no laptop: as tabelas e os arquivos estão na VPS, e o
# script é READ-ONLY (nenhum INSERT, nenhum UPDATE).
ingest-status:
	@docker exec adr-lead-manager node /app/scripts/ingest-status.js $(ARGS)

# Sobe, roda tudo, derruba — o down acontece mesmo com teste vermelho.
test-all:
	@$(MAKE) test-db-up
	@rc=0; \
	 $(MAKE) test         || rc=$$?; \
	 $(MAKE) test-origem  || rc=$$?; \
	 $(MAKE) test-isolation || rc=$$?; \
	 $(MAKE) test-ingestao || rc=$$?; \
	 $(MAKE) test-db-down; \
	 if [ $$rc -ne 0 ]; then echo "[ci] VERMELHO"; else echo "[ci] verde"; fi; \
	 exit $$rc

ci: test-all

# ── migração à mão num banco local ────────────────────────────────────────────
guard-nao-producao:
	@case "$(PSQL_DSN)" in \
	  *127.0.0.1*|*localhost*) : ;; \
	  *) echo "RECUSADO: PSQL_DSN não é local ($(PSQL_DSN)). Migração de produção é feita à mão, com backup."; exit 1 ;; \
	esac

migrate: guard-nao-producao
	@set -euo pipefail; \
	for m in $(MIGRATIONS); do \
	  echo "[migrate] $$m"; \
	  $(PSQL) -d lm_plataforma < db/migrations/$$m.sql; \
	done; \
	for g in $(GRANTS); do \
	  echo "[migrate] grants: $$g"; \
	  $(PSQL) -d lm_plataforma < db/grants/$$g.sql; \
	done; \
	echo "[migrate] ok"
