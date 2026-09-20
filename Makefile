# Makefile — atalhos de migração e teste do Lead Manager / núcleo de plataforma.
#
# NUNCA aponte PSQL_DSN para produção: `make migrate` aplica DDL. O alvo `guard-nao-producao`
# recusa DSN que não seja local, justamente para isso não acontecer por distração.
#
#   make migrate PSQL_DSN=postgres://postgres:itest@127.0.0.1:55473/lm_itest
#   make test          # testes puros (sem banco, sem rede)
#   make itest         # suíte BLOQUEANTE de isolamento entre unidades (precisa de Docker)
#   make ci            # test + itest — é isto que o build roda
#
SHELL := /bin/bash
PSQL  ?= psql
PSQL_DSN ?= postgres://postgres:itest@127.0.0.1:55473/lm_itest

# Migrações desta frente. Para aplicar outras, passe MIGRATIONS="172_plataforma_nucleo ...".
MIGRATIONS ?= 172_plataforma_nucleo 173_marketing_nucleo
# Grants que acompanham as migrações (leitura da contratação em app.tenant_modules).
GRANTS ?= plataforma_contratacao_read

# Testes puros: rodam offline e não tocam em banco nenhum.
UNIT_TESTS := test/plataforma.test.js test/origem-lead.test.js test/webhook.test.js test/waConteudo.test.js

.PHONY: migrate test itest ci guard-nao-producao

guard-nao-producao:
	@case "$(PSQL_DSN)" in \
	  *127.0.0.1*|*localhost*) : ;; \
	  *) echo "RECUSADO: PSQL_DSN não é local ($(PSQL_DSN)). Migração de produção é feita à mão, com backup."; exit 1 ;; \
	esac

migrate: guard-nao-producao
	@set -euo pipefail; \
	for m in $(MIGRATIONS); do \
	  echo "[migrate] $$m"; \
	  $(PSQL) "$(PSQL_DSN)" -v ON_ERROR_STOP=1 -q -f db/migrations/$$m.sql; \
	done; \
	for g in $(GRANTS); do \
	  echo "[migrate] grants: $$g"; \
	  $(PSQL) "$(PSQL_DSN)" -v ON_ERROR_STOP=1 -q -f db/grants/$$g.sql; \
	done; \
	echo "[migrate] ok"

test:
	node --test $(UNIT_TESTS)

itest:
	bash test/run-plataforma-itest.sh

ci: test itest
	@echo "[ci] núcleo + isolamento verdes"
