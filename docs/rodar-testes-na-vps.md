# Rodar os testes de banco na VPS

Os testes que precisam de Postgres (isolamento entre unidades, origem do lead) rodam
**onde houver Docker** — hoje, a VPS. É a mesma prática dos itests antigos do Lead Manager
(anexo do ADR-051, linha 117). A máquina de desenvolvimento não tem Docker nem Postgres.

## O que sobe, e por que não é produção

`docker-compose.test.yml` sobe um `postgres:16-alpine` **vazio**, que nasce e morre com o
teste. Ele não é, e não pode virar, o banco de verdade:

| | teste | produção |
|---|---|---|
| container | `adr-lm-pg-teste` | `exp44a3i0nnip54f4xc0is0i` |
| porta | 5433, presa em `127.0.0.1` | 5432 |
| dados | `tmpfs` — somem no `down` | disco |
| banco | `lm_origem`, `lm_plataforma` | `adr_scheduler` |
| limites | 1 CPU, 1 GB (risco X10) | — |

E o alvo `make migrate` recusa qualquer DSN que não seja `127.0.0.1`/`localhost`, então
migração de teste não alcança a VPS por distração.

## Passo a passo

```bash
cd /apps/lead-manager
git fetch origin
git switch feat/origem-lead-e-nucleo-plataforma
make test-all
```

`test-all` sobe o banco, roda os testes puros, a suíte da origem do lead, a suíte de
isolamento, e **derruba o container no fim mesmo se algum teste falhar**.

Ao terminar, devolva a árvore para a main — senão o próximo deploy publica a branch errada:

```bash
git switch main
```

## Quando NÃO rodar

- **22h–23h BRT**: janela do backup e da contagem de referência.
- Em horário de pico de atendimento: o container divide CPU e disco com quem está sendo
  atendido de verdade. Os limites de 1 CPU / 1 GB reduzem o estrago, não o eliminam.

## O que nunca fazer

Apontar `DATABASE_URL` para `adr_scheduler` e rodar a suíte. Ela cria unidades fictícias,
grava credenciais e faz `TRUNCATE` — é escrita, não leitura. É o risco **C7** do anexo do
ADR-051 (teste do LM escrevendo em produção), catalogado antes de qualquer uma destas
frentes existir.

## Se `make` não existir na VPS

`apt-get install -y make`, ou rode à mão o que o alvo faz: `docker compose -f
docker-compose.test.yml up -d`, os `psql` de bootstrap de `test/db/`, as migrações, e
`node --test test/isolamento-tenant.itest.js` com `DATABASE_URL` apontando para a 5433.
O Makefile é a fonte da verdade da ordem exata.
