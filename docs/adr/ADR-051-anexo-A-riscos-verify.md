# ADR-051 — Anexo A: Risk register e plano de verificação (VERIFY/FORGE)

- **Data:** 16/09/2026
- **Autor:** VERIFY (QA do time FORGE), levantamento só de leitura
- **Status:** base para o fatiamento em janelas; os itens marcados [SUPOSIÇÃO] precisam de confirmação
- **Checagens de confirmação feitas em 16/09/2026 (só leitura, VPS):**
  - **F0-4/R5 confirmado:** o log das 05:45 mostra `service_account enriquecido: 0 contratos` todos os dias. O job não faz nada desde a migr. 074.
  - **C6/R1:** a mensagem mais antiga é de 11/09/2024 e **nenhuma conversa tem a última mensagem antes de 01/10/2024**. O cenário de falso positivo não ocorre em 01/10/2026.
  - **X4 confirmado:** o host está em **UTC** e o cron **ignora CRON_TZ**. Todos os horários do crontab são UTC; ver ADR §10a.

---


Fiz só leitura: nenhum arquivo alterado, nada rodado contra produção, sem ssh. A única chamada de rede foi um `git fetch --dry-run` no clone do scheduler, que não grava nada.

**Resumo:** o ADR está certo na direção (tudo aditivo, modo sombra, flag por job). Mas **ainda não dá para um agente executar sozinho**. Faltam coisas que, se esquecidas, param Valinhos inteira: GRANT de USAGE no schema novo, lock das policies, backup sem roles/uploads/segredos, testes que hoje gravam no banco de produção, falta de homologação e rollback de código que não existe no deploy do dashboard. Abaixo, os achados com arquivo:linha. O que eu não consegui confirmar está marcado **[SUPOSIÇÃO]**.

---

## A) Registro de riscos

### A.0 CRÍTICOS (topo)

| ID | Risco e cenário concreto | P | I | Detecção | Mitigação | Rollback |
|---|---|---|---|---|---|---|
| **C1** | **Falta GRANT USAGE no schema `plataforma`.** O ADR (D8) prevê só `GRANT SELECT ON plataforma.unidade_chave`. A policy nova faz subselect em `plataforma.*`, e esse acesso é checado como o usuário da consulta. O LM conecta direto como `lead_manager_user` (`src/db.js:7-12`, search_path desse role). O dashboard usa esse mesmo role via `SET LOCAL ROLE` (`dashboard/lib/db.js:80,108,157`). Sem USAGE, **toda** consulta em **toda** tabela com RLS dá "permission denied for schema plataforma": LM fora do ar, webhook falhando, telas do Diapasão/BI/Compasso fora. | M | Crítico | T-RLS-05 na homologação. No deploy: grep de `permission denied` nos logs 60 s depois do 1º lote. | GRANT USAGE + SELECT **na mesma transação e antes** do 1º CREATE POLICY. 1º lote numa tabela pequena e sonda antes de seguir. | `DROP POLICY IF EXISTS <nova>` por tabela, com script pronto e `lock_timeout`. |
| **C2** | **CREATE POLICY pega AccessExclusiveLock.** Em `lead_manager.messages`, `conversations`, `leads` e `staff_outbound_samples`, o comando fica na fila atrás de transação longa: pg_dump das 03:00 UTC, cadastro-sync de "várias horas" (`deploy/crontab.cadastro-sync.txt:9`), ETL do BI, EXPLAIN ANALYZE. Tudo que chega depois fica preso atrás dele. Resultado: webhook do Evolution estoura timeout e a mensagem que entra pode se perder **[SUPOSIÇÃO: não sei se o Evolution reenvia]**. Uma transação única com ~100 tabelas ainda arrisca deadlock com o app. | M/A | Crítico | `pg_stat_activity` com `wait_event_type='Lock'` > 5 s. 5xx do webhook no log do LM. | Uma transação por tabela. `SET lock_timeout='3s'` + retentativa (3×). Nunca durante o pg_dump. Pré-voo abortando se houver `xact_start` > 60 s. Tabelas quentes por último. | Idem C1. O DROP POLICY também pega lock: mesma técnica. |
| **C3** | **Backup incompleto, restauração impossível.** O dump de um banco só não leva roles (senha de `lead_manager_user`), `ALTER ROLE lead_manager_user SET work_mem='64MB'` e `search_path`, nem `ALTER DATABASE … jit=off`. As três já causaram incidente (memória: RLS 706 ms × 30 s). Também ficam fora: `./uploads` (1,1 GB), `.extranet-session`, segredos do `.env` e o banco/volumes do Evolution. Não há cópia fora da VPS. Se a VPS cair, perde-se mídia e sessão do WhatsApp, e o certificado fica ilegível. | A | Crítico | T-RESTORE-01. | backup v2: `pg_dumpall --globals-only` + rsync de uploads e `.extranet-session` + cópia fora da VPS + segredos cifrados em guarda separada (custódia humana). | n/a (proteção). |
| **C4** | **Instância de restauração/homologação dispara ações reais.** O banco restaurado tem tokens do Evolution, credencial da Extranet e filas (`app.envio_pendente`, campanha). Se subir o LM (`server.js:107-205` liga node-cron sozinho: reprocessar a cada 2 min, renovação auto 10h) ou o dashboard (orchestrator de 60 s, campanha, ETL), o resultado é mensagem real para aluno, login na Extranet com `force:true` derrubando a sessão de produção ou gerando bloqueio 429, e chamada ao Gemini. | M | Crítico | Tráfego de saída do container de teste. | Container com `--network none`/rede interna. `ORCHESTRATOR_ENABLED=false`, `DRY_RUN`. URLs do Evolution/Gemini/Extranet apontando para destino inválido. Para decifrar certificado/credencial, rodar só o script, sem subir o servidor. | Derrubar o container. |
| **C5** | **Restauração no banco errado.** `psql -d adr_scheduler` no lugar de `adr_scheduler_restore_teste` (mesmo cluster, mesmo container `exp44a3i0nnip54f4xc0is0i`, `db/apply-migration.sh:27`) duplica linhas ou quebra produção. | B | Crítico | — | Restaurar **em outro container Postgres**, nunca no cluster de produção. Script com asserção do host/porta. | Nenhum limpo. Prevenir. |
| **C6** | **R1 dataRetention em 01/10 03:00** (`LM src/server.js:124-133`). Hoje casa zero leads, mas há falso positivo possível: o opt-out manual grava `OPTED_OUT` com `updated_at=now()` (`src/routes/tenant.js:2217`). Se a conversa casar por `cv.external_id = l.phone` (`dataRetention.js:33-38`) e a última mensagem for do histórico importado com mais de 730 dias **[SUPOSIÇÃO: há mensagem `source='historico'` anterior a 09/2024]**, o lead é anonimizado na hora e o corpo das mensagens vira `[removido]` (`anonymize.js:14-20`). **Não existe teste de dataRetention** em `test/`. A contagem de linhas não detecta, porque a anonimização é UPDATE. | B | Crítico (irreversível) | Consulta idêntica em modo leitura, diária até 30/09. | Decisão do Leo: (a) `retention_days` alto em `tenants` (config reversível, sem deploy) ou (b) deploy em modo simulação. Pré-voo obrigatório em 30/09. | (a) voltar o valor. Sem volta depois de rodar. |
| **C7** | **Testes "de gate" gravam em produção.** Memória `deploy-vps-adr-lead-manager`: overlay em /tmp "escreve no DB real". `test/gate-isolation.test.js:25-45`, `gating.test.js:7-8,70`, `admin.test.js:50-51`, `rbac.test.js:64-66` e `engine.test.js:50` usam `DATABASE_URL` e Redis reais, criam tenant com `lead_manager_active=true` (que `tenants_active()` enxerga nos crons) e fazem `DELETE FROM tenants … CASCADE`. `npm test` = `node --test test/` pode pegar também os `.itest.js` e `gate-*.js` **[SUPOSIÇÃO: regra de glob do Node 20 para diretório]**. Um agente sem supervisão que rode "os testes" no container vai mexer em produção. | M | Crítico | — | Proibir no runbook. Todo teste com banco roda em Postgres efêmero montado com `pg_dump --schema-only` + globals de produção. | — |
| **C8** | **Portão falhando fechado** (Fase 4/5). Se `pode_rodar` lançar erro (permissão/RLS em `plataforma.*`, tabela ausente porque o deploy veio antes da migration, `portao_log.unidade_id NOT NULL` sem unidade resolvida), todos os jobs de Valinhos "pulam" sem aviso. Na sombra, se o INSERT no `portao_log` estiver dentro da transação do job, aborta o job. | M | Crítico | `portao_log` sem linha por execução. Ledger de execuções. | Erro de infra ≠ negação: roda + alerta (mesma lógica do `requireModulo` de hoje). INSERT de log em transação própria, com try/catch. Migration antes do código. | Flag por job. |
| **C9** | **Fase 6: E2 derivado erra.** `tenant_subscriptions` de Valinhos sai de ACTIVE, e `gating.js:37-49` (cache de 5 min no Redis) bloqueia a Janis. `runTrialExpiry` também passa a agir. | M | Crítico | Veredito do gating por tenant a cada 1 min durante a janela. | Derivação em sombra: grava tabela de comparação, nunca E2, por 14 dias. Troca com humano presente. | Voltar a linha + limpar cache `sub:{tenant}:lead_manager`. |
| **C10** | **Deploy leva commits de outras sessões.** `deploy-dashboard.sh` builda `origin/main` inteiro. Pode subir, por exemplo, código do financeiro que espera a migr. 114 ainda não aplicada, ou o telão do Rock Hour. O LM builda o working tree da VPS, inclusive o que não foi commitado. Há dois clones do scheduler divergentes (`C:\dev\…` em 0b949b7, `C:\Users\leona\…` em 00fb882 com a 114). A árvore `C:\dev\adr-whatsapp-scheduler` é compartilhada entre sessões, e o próprio ADR-051 **não está commitado** (`?? docs/adr/…`). | A | A | `git log <SHA-em-prod>..<SHA-alvo>` revisado no pré-voo. | Congelar por SHA e deployar por SHA. Worktree isolado a partir de `origin/main`. Freeze de merge das outras sessões durante a janela. | Tag da imagem anterior (ver D). |

### A.1 Transversais

| ID | Risco e cenário | P | I | Detecção | Mitigação | Rollback |
|---|---|---|---|---|---|---|
| X1 | **Não existe rollback de código no dashboard.** `deploy-dashboard.sh:147` sobrescreve `adr-dashboard:latest`, e a linha 156 faz `docker rm -f` antes do `run`. Voltar exige revert + push + novo build. | A | A | — | Antes da janela: `docker tag …:latest …:pre-<janela>` nos dois apps + script de "run com imagem X", testado num dia útil. | Script. |
| X2 | **Restaurar o dump não serve de rollback de janela.** Perde tudo que entrou desde o backup (WhatsApp, leads), o que viola o requisito 2. Não há PITR/WAL **[SUPOSIÇÃO]**. | A | Crítico | — | Regra: rollback = desfazer o passo, nunca restaurar. Dump fresco só como último recurso, decidido por humano. | — |
| X3 | **Crons do host em `docker exec` falham** durante a recriação dos containers. Uma sync diária se perde sem aviso (ex.: cadastro 04h). | M | M | `/var/log/*-sync.log`. | Janela fora dos horários. `crontab -l > backup` e crontab filtrado durante a janela. | Restaurar crontab (item do checklist de saída). |
| X4 | **O `CRON_TZ` pode ser ignorado** (`deploy/crontab.*.txt`). O cron do Debian/Ubuntu não tem suporte garantido **[SUPOSIÇÃO]**. Se o host estiver em UTC, "03h" = 00h BRT, **ao mesmo tempo que o pg_dump das 03:00 UTC**. | M | M | Horário real no syslog do CRON × log do job. | Verificar antes de escolher a janela. | — |
| X5 | **O orchestrator não pausa sem restart** (`orchestrator.js:1441-1448`, env só no start). O guard do ETL do BI fica em memória (`bi-etl-extranet.js:493-495`, `_ultimaRodada`): restart do dashboard entre 22h e 08h (TZ=America/Sao_Paulo, `deploy-dashboard.sh:212`) roda o ETL de novo na hora, com scraping da Extranet e reescrita de `bi_raw.contracts`. | A | M | Log `[bi-etl]`. | Deploy do dashboard fora de 22h–08h, ou aceitar e registrar. | — |
| X6 | **Login forçado na Extranet** (`cancelamentos.js:78`, scripts com `force:true`) durante testes ou dry-runs. O bloqueio 429 pausa a agenda (`orchestrator.js` "Extranet bloqueou"). | M | A | Alerta de bloqueio. | Replay com fixtures gravadas. Proibido scraping real fora do agendado. | Esperar o cooldown. |
| X7 | **Agente sem supervisão travado no meio.** Comandos de escrita na VPS podem ser bloqueados pelo classificador (memória de deploy) e deixar a janela pela metade. | A | A | Timeout de passo. | Runbook idempotente, com checkpoint e todo passo seguro para parar. Permissões pré-aprovadas. Humano de plantão por WhatsApp. | Rollback do passo corrente. |
| X8 | **Migrations sem ledger e sem atomicidade.** `apply-migration.sh:27` usa `ON_ERROR_STOP` sem `--single-transaction`, então só a migration com BEGIN/COMMIT próprio é atômica (13 de 116 no LM). Não há tabela de migrations aplicadas. Números duplicados no scheduler: `089_*`×2 e `095_*`×2. A 114 do LM ≠ a 114 do scheduler. | A | M | Diff de `pg_dump --schema-only`. | Cada migration nova com BEGIN/COMMIT, `lock_timeout`, verificação no fim e `\echo` do estado. Ledger em arquivo versionado. | Script de reversão por migration. |
| X9 | **Contagem de referência dá falsa confiança.** Não detecta UPDATE destrutivo (R1, R5). Tabelas com refresh total oscilam todo dia (`aluno_status`, `aluno_professor`, `cancelamento_motivo`, `resource_availability`, caches, `wa_ack_pendente`). Rodando como `lead_manager_user`, tudo sai zerado (o aviso já está em `db/checks/auditoria-fase0-baseline.sql`). | A | A | — | Classificar tabela a tabela (monotônica / oscilante / efêmera). Impressão digital por coluna: `count(*) FILTER (WHERE body='[removido]')`, `phone LIKE 'anonimizado_%'`, `professor_nome IS NULL`. Rodar como postgres. | — |
| X10 | **Não existe homologação.** Docker não roda nesta máquina (memória `leads-query-rls-perf`); os itests rodam em container efêmero **no host de produção** (CPU/IO disputados). A "unidade fictícia em homologação" (Fase 1) não tem onde viver. | A | A | — | Homologação efêmera na VPS com limites (`--cpus 1 --memory 1g`) e rede isolada, ou uma VM ou Docker local. Unidade fictícia nunca no banco de produção. | — |

### A.2 Fase 0

| ID | Risco e cenário | P | I | Detecção | Mitigação | Rollback |
|---|---|---|---|---|---|---|
| F0-1 | **R3 com upsert + `fonte_ausente_em` muda o resultado do dia normal.** Hoje `aluno_status` é DELETE+INSERT (`qualidade-db.js:791-821`, DELETE em 804). Com upsert, linhas `situacao='ativo'` antigas ficam. Há ~14 leitores sem filtro: `qualidade-db.js:66,446,857,1228,1400,1465,1497,2276`, `lib/db.js:1106`, `qualidade-faltas.js:73`, `qualidade-reconquista-db.js:60,64`, `qualidade-snapshot.js:117,330`. Efeito: alerta de falta para o professor errado, Mapa e fila de reconquista distorcidos. **Viola o requisito 1.** | A | A | Replay: saída dos leitores antes × depois. | **Fase 0 só com a guarda de queda** (pula o refresh se cair > X%) e DELETE+INSERT mantido no dia normal. Upsert vira decisão separada. | Flag. |
| F0-2 | **R2 não está agendado** (fato do crontab). Só roda manual (`scripts/scrape-cancelamentos.js`). Não há dia normal para comparar em produção. | — | B | — | Validar só por replay. Baixa prioridade. | Flag. |
| F0-3 | **R4: a guarda estendida pode barrar mudança legítima de horário de professor.** A guarda atual só conta recursos (`daily-sync.js:86-96`). Os deletes estão em `sync.js:149-170` (capacidades) e `187-191` (disponibilidade). Um professor com página vazia perde toda a disponibilidade. Por outro lado, apagar faz parte do dia normal: trocar DELETE por "inativar" exige que `routes/resources.js:383,496,645` filtrem, senão a grade mostra horário antigo. | M | A | Replay + diff da API da grade. | Guarda por recurso ("tinha ≥1 disponibilidade, veio 0 e o recurso segue presente → não apaga esse recurso, loga"). Manter o DELETE nos demais casos. | Env `RESOURCES_SAFEGUARD_*`. |
| F0-4 | **R5 provavelmente não faz nada desde a migr. 074 (28/08).** `backfill-sa-enriquecimento.js:37` roda em `withTenant` (uuid do LM, role `lead_manager_user`), e o CTE `latest` lê `bi_raw.contracts` (linhas 11-16), que tem RLS FORCE comparando `"tenantId"` com texto. Resultado: 0 linhas e o UPDATE (24-32) atualiza 0 **[SUPOSIÇÃO forte: conferir "enriquecido: N" no log]**. "Consertar" (COALESCE + filtro de unidade, e o contexto certo) **retoma UPDATE em massa**, uma mudança grande em relação a hoje. **A citação do ADR (263-285) está errada: o arquivo tem 41 linhas.** | M | A | Log do cron das 05:45. | Confirmar primeiro. Decisão do Leo: manter parado ou retomar com replay comparado. | Flag. |
| F0-5 | **R6: a Evolution é apagada antes do banco** (`routes/admin.js:546-547`). Se a exclusão falhar, a sessão do WhatsApp já foi (irreversível, exige QR de novo). | B | A | — | Esconder o botão para franquia com dados (Fase 0.5) e inverter a ordem. | Deploy anterior. |
| F0-6 | **Teste de restauração em dia útil** disputa IO/CPU com a produção e com o backup. | M | M | Latência do inbox. | À noite, fora de 22h–08h do ETL, com limites de container. | Parar o container. |

### A.3 Fase 1 (127: identidade + 2ª policy)

| ID | Risco e cenário | P | I | Detecção | Mitigação | Rollback |
|---|---|---|---|---|---|---|
| F1-1 | **Regressão de plano com `tenant_id = X OR tenant_id = (initplan)`.** Pode perder index cond, keyset e o corte cedo das migr. 111/112. A memória registra que sob RLS o planner já rebaixou filtros (30 s) e que LATERAL piorou. Rotas mais expostas: inbox, badge, /leads, renovações. Timeout de 10 s = "Não consegui falar com o Lead Manager". | M | A | T-PERF-01 (EXPLAIN sob ROLE+set_config). | Medir na cópia restaurada antes. **Restringir a 2ª policy às tabelas que o 1º consumidor (Folha) precisa**, não "todas as tabelas com RLS". | DROP POLICY da tabela. |
| F1-2 | **Colunas de policy heterogêneas.** O modelo `tenant_id = …` do ADR quebra em `lead_manager.tenants` (`id`, migr. 001:54-56), `classifier_shadow` (`tenant`, migr. 034:48) e `bi_raw.investment_entries/returns` (EXISTS no pai, 074:79-104). Um CREATE POLICY falha no meio. | M | M | Migration aborta. | Gerar as policies por introspecção de `pg_policy` + catálogo. Uma transação por tabela. | Idempotente. |
| F1-3 | **Armadilha do OR / vazamento de GUC.** O LM **não tem DISCARD ALL** (`src/db.js:26-43`). Se `withUnidade` usar `set_config(…, false)`, o valor vaza para a próxima requisição do pool e as duas unidades ficam visíveis. No dashboard, `poolBi` usa o client do contexto (`lib/db.js:181-187`): `withUnidade` aninhado dentro de `withTenantBi` herdaria `current_tenant`. | B | Crítico | T-RLS-04, T-RLS-06. | `is_local=true` sempre. `withUnidade` recusa rodar dentro de outro contexto. Asserção de `current_setting` no início de cada helper. | Não usar o helper. |
| F1-4 | **Tabela nova sem a 2ª policy** (financeiro 114, boas-vindas 120–125, tudo que as sessões criarem depois). Tela com `withUnidade` mostra zero ("não coletado vira zero", regra 5). | A | M | T-RLS-02 / teste do catálogo. | Teste que exige as duas policies em toda tabela com RLS, nos dois repositórios. | Criar a policy. |
| F1-5 | **Seed de `unidade_chave` com valor ruim** (franquia sem `lead_tenant_id`/`bi_tenant_id`, lixo em `valor`). `valor::uuid` erra para aquela unidade. | B | M | CHECK. | `CHECK (tipo<>'lead_tenant' OR valor ~ '^[0-9a-f-]{36}$')`. Relatório de franquias sem chave antes de gravar. | Linha nova, remover. |
| F1-6 | **`plataforma.*` sem RLS definida.** `lead_manager_user` passa a ler o mapa de chaves e (Fase 2+) as assinaturas de todas as unidades. Com RLS por `app.unidade`, os helpers antigos leem zero e a C8 acontece. | M | M | — | Decidir no ADR (ver E). | — |
| F1-7 | **A comparação da Folha fica visível para o usuário.** Folha "oficial" desde outubro (migr. 104) é usada para pagar professores: número divergente na tela = pagamento errado. | B | A | — | Comparação invisível, só log. | — |

### A.4 Fases 2 a 7

| ID | Risco e cenário | P | I | Detecção | Mitigação | Rollback |
|---|---|---|---|---|---|---|
| F2-1 | **Teste do catálogo bloqueia deploy alheio** (outra sessão cria tabela) ou é "resolvido" com classificação fictícia. | A | M | — | Rodar como aviso por 7 dias antes de bloquear. Classificação duvidosa exige revisão do Leo. | — |
| F2-2 | **Seed de assinaturas "legado" errado** (RECURSOS fora de E1, QUALIDADE sem migration). | M | B (nada lê ainda) | Reconciliação. | Lista confirmada pelo Leo. | DELETE de linhas novas. É exceção à regra 1: declarar. |
| F3-1 | **Gravação de `ultima_sync_ok` dentro da transação do job.** Se falhar, a sync inteira sofre rollback. "Uma linha no fim" pode estar dentro do `withTenant` do sync (`daily-sync.js:143-144`). | M | A | Ledger. | Transação própria + try/catch, sem efeito no job. | Flag/remover chamada. |
| F3-2 | **`desde` e cobertura errados** (as tabelas não têm coluna de data padrão). | M | M | — | Definir coluna de data por tabela no catálogo. | — |
| F4-1 | **Comparar loop antigo × novo rodando os dois.** Scraping em dobro na Extranet (bloqueio) e refresh total em dobro. | A | A | — | O novo roda em **dry-run** sobre a entrada gravada pelo antigo. | Flag. |
| F4-2 | **Remover valor fixo desvia alerta.** `orchestrator.js:1262,1310` (`!== 13`): o alerta da Extranet vai para ninguém (`dest.length=0`, só `console.error`). `campanha.js:264`: franquia sem `lead_tenant_id` falha. `engine.js:598-603` (`franquia_id = 1`). `bi-financas.js:19`. | M | A | Teste por PR + replay. | Um PR por valor, com teste de rota. | Deploy anterior. |
| F4-3 | **Volume do `portao_log`.** Tick de 60 s × jobs × unidades, sem PK/índice/retenção. | M | B | Tamanho da tabela. | Índice (unidade, job, em). Particionar ou agregar. | — |
| F5-1 | **`requireModulo` passa a falhar fechado** (`auth.js:140-151`). Numa oscilação do banco, a recepção perde Renovações/Diapasão/Compasso. **Viola o requisito 1 no "dia ruim"**, e a Fase 5 ainda passa a proteger rotas só escondidas no menu (RECURSOS não está em E1). | A | A | 404 nos logs. | Manter a falha aberta por erro de infraestrutura e negar só por regra. | Flag. |
| F5-2 | **Flags de portão sem armazenamento definido.** Se forem env, cada ligar/desligar exige restart (X5). | A | M | — | Flag em tabela, lida a cada execução. | Voltar a linha. |
| F7-1 | **Código de exclusão ligado por engano / credencial apagada na hora** (D10 é irreversível por desenho). | B | Crítico | Teste de configuração em produção (flag = off). | Duas chaves (env + tabela) e aprovação registrada. Só homologação. | Nenhum. |

---

## B) Comparação "antes × depois"

**Regra geral:** o que é determinístico se compara **igual** (EXCEPT nos dois sentidos = 0), na **cópia restaurada** (dado parado) ou com **replay de entrada gravada**. Em produção só se comparam **taxas, latências, erros e contagens com tolerância**. O time já usa esse método (memória Rodada 4: `WITH nova…, velha… EXCEPT`) e já tem baseline pronto (`db/checks/auditoria-fase0-baseline.sql`).

| Mudança | O que medir | Como capturar o baseline | Tolerância | Determinístico? |
|---|---|---|---|---|
| **Migrations aditivas (127–131)** | (1) diff de `pg_dump --schema-only`: só objetos `plataforma.*`, policies novas e grants; (2) as ~15 leituras canônicas com helpers antigos (inbox lista/thread/badge, /leads, renovações, DRE mês, contratos, Folha, Mapa, faltas) dão resultado idêntico; (3) EXPLAIN (ANALYZE, BUFFERS) sob `SET ROLE lead_manager_user` + `set_config`; (4) erros no log | Cópia restaurada: rodar (2) e (3) antes e depois de aplicar. Em produção: (3) e contagens no pré-voo | (1) zero objeto inesperado; (2) EXCEPT = 0; (3) p50 ≤ max(+15%, +20 ms), sem Seq Scan novo em messages/conversations/leads; (4) zero `permission denied`/`invalid input syntax for type uuid` | Sim na cópia; em produção, só tempo e erro |
| **Isolamento (policy nova)** | Matriz por tabela × contexto (antigo LM, antigo BI, `withUnidade` Valinhos, `withUnidade` fictícia, vazio, os dois preenchidos com unidades diferentes) × operação (SELECT, INSERT da outra unidade, UPDATE/DELETE) | Cópia restaurada + unidade fictícia com dados sintéticos | 0 linhas vazadas; `withUnidade(Valinhos)` EXCEPT antigo(Valinhos) = 0 dos dois lados | Sim |
| **Portões em sombra** | (a) ledger por job/dia: nº de execuções, duração, linhas gravadas (`resource_sync_log`, `cadastro_sync_log`, `etl_logs`, `envio_log`, `nps_agendamento_log`, `diario_lembrete_log`, `falta_alerta_log`, `automacao_log`); (b) 1 linha de `portao_log` por execução × unidade; (c) 100% `rodaria` | 14 dias antes do deploy | (a) nº de execuções **exato** pela agenda; duração ≤ +10%; linhas gravadas dentro de média ± 3σ dos 14 dias; (b) 100% de cobertura; (c) todo `pularia` explicado | Execuções sim; volumes não (a Extranet muda sozinha) |
| **Loop por unidade (Fase 4.2)** | Linhas que o novo **gravaria** (dry-run → JSON) × o que o antigo gravou com a **mesma entrada** | Gravar a resposta da Extranet (HTML/CSV/Excel) da execução antiga | Igual nas colunas de negócio; ignorar `capturado_em`, `updated_at`, ids gerados | Sim com replay |
| **Proteções R2–R5** | Dia normal: tabela final e **saída dos leitores** iguais às do código antigo. Dia ruim (fixtures: vazio, −50%, 1 professor sem disponibilidade, Excel com professor em branco): o novo preserva e o antigo destrói (diferença documentada). Em produção: modo "só log" (guarda **teria** barrado?) | Fixtures reais do dia + fixtures fabricadas; cópia restaurada | Dia normal: EXCEPT = 0; em produção, **0 disparos** da guarda em 7 dias normais. Qualquer disparo em dia normal = limiar mal calibrado → NO-GO | Sim com replay |
| **R1** | Nº e ids que seriam anonimizados; impressão digital (`body='[removido]'`, `phone LIKE 'anonimizado_%'`) | Consulta em modo leitura diária até 30/09 | = 0 | Sim (depende do relógio: fixar `now()`) |
| **Helper withUnidade (telas)** | Leitura dupla em sombra: calcula o antigo (2 transações + junção em JS) e o novo, compara hash e **serve o antigo** | 7 dias | 0 divergências; divergência por escrita concorrente é revalidada 1× antes de contar | Quase (corrida de escrita) |
| **IA / horário / WhatsApp** | IA: só decisão estrutural (chamou? com hash do prompt igual?), nunca o texto. Horário: relógio injetável (`trialExpiry` já tem `deps.now`). WhatsApp: taxas por hora, não igualdade | — | — | Não |

---

## C) Plano de testes

### C.1 Testes existentes que viram gate, e como rodá-los

- **LM, sem banco** (node puro, local): `bola.test`, `horario.test`, `temaProibido.test`, `perfil-assistente.test`, `dedup-person.test`, `waEdicao.test`, `wa-sync.test`, `trialExpiry.test`, `metaReferral.test`, `resiliencia503.test` etc. Roda com `node --test test/<arquivo>` **arquivo por arquivo**, nunca `npm test`.
- **LM, com banco** (`gate-isolation`, `gating`, `admin`, `adminPanel`, `rbac`, `engine`, `intent_extraction` `.test.js`):
  - **só contra Postgres efêmero** com schema = `pg_dump --schema-only` de produção + `pg_dumpall --globals-only` (roles com senha trocada) + Redis efêmero;
  - **o overlay em produção fica proibido para o agente** (C7).
- **LM, itests**: `test/run-*-itest.sh` (ex.: `run-renovacao-itest.sh`, `run-inbox-itest.sh`, `run-resources-sync-itest.sh`, `run-sync-cadastro-itest.sh`, `run-cadastro-mestre-itest.sh`, `run-dedup-person-itest.sh`) sobem `postgres:16-alpine` em 127.0.0.1. Rodam onde houver Docker (hoje, só a VPS, em `/apps/lead-manager`). Adicionar `--cpus`/`--memory`.
  - ⚠ os itests montam **schema mínimo à mão**, então não pegam a 2ª policy. Precisam de uma variante com schema completo.
- **Dashboard**: `npm test` (`node --test test/*.test.js`) usa `withTenant` **falso** (ex.: `test/rockhour-afinidade-texto.test.js:18`), então **não pega nada de RLS**. `npm run check:isolation` (verificador estático; regex só `lead_manager|rock_hour`, `scripts/check-lead-manager-isolation.js:20`, diferente de `lib/db.js:40`). `campanha.itest.js` só com `DATABASE_URL` efêmero.

### C.2 Testes novos por fase

| Fase | Unit | Integração (PG efêmero com schema de prod) | E2E / na cópia restaurada |
|---|---|---|---|
| 0 | **T-R1**: dataRetention (formato `+55`×`55`, histórico > retenção, OPTED_OUT recente, simulação sem UPDATE). **T-R2/R3/R4/R5**: guarda normal × ruim. **T-R6**: bloqueio + ordem Evolution/banco | Replay R3/R4 com fixtures, EXCEPT da tabela e dos leitores | **T-RESTORE-01** (abaixo). Contagem de referência: rodar 2× seguidas = 0 alarme; UPDATE destrutivo simulado → alarme |
| 1 | `withUnidade`: `is_local`, zera `current_tenant`, recusa aninhar | **T-RLS-01** matriz de isolamento; **T-RLS-02** inventário (toda tabela com RLS tem as 2 policies e a coluna certa); **T-RLS-03** sem erro de cast novo; **T-RLS-04** GUC não vaza no pool (LM e dashboard); **T-RLS-05** sem contexto, SELECT dá 0 linhas **sem erro de permissão**; **T-RLS-06** armadilha do OR documentada e bloqueada; **T-LOCK-01** migration com transação longa concorrente aborta por `lock_timeout` sem estado parcial e retoma idempotente | **T-PERF-01** EXPLAIN das rotas quentes antes/depois; Folha dupla idêntica; **T-ROLLBACK-01**: aplica → reverte → `schema-only` igual ao original → reaplica |
| 2 | Fecho de dependências do manifesto | **T-CAT-01**: criar tabela sem grupo → teste vermelho; mista sem regra → vermelho; diretório ausente → vermelho. **T-CAT-02**: tabela com RLS sem a 2ª policy → vermelho | Reconciliação E1/E2 × assinatura em Valinhos = 0 divergências |
| 3 | — | Falha ao gravar cobertura **não** aborta o sync | — |
| 4 | **T-GATE-01**: tabela-verdade de `pode_rodar` (estados × fecho × mínimo de identidade); sombra sempre true; exceção → roda + alerta | **T-GATE-02** verificador estático: todo job do §5 chama `pode_rodar`; grep que falha com `ed731a58`, `cmo7t25gz`, `franquia_id = 1`, `!== 13`, `\|\| '1'` | Dry-run do loop × saída antiga (replay) |
| 5 | Flag em tabela lida por execução | `requireModulo`: erro de infraestrutura → libera; negação por regra → 404 | Um job por vez: 48 h de ledger + contagem |
| 6 | Derivação E1/E2 | `gating.js` com cache: troca de estado reflete em ≤ 5 min | Sombra de 14 dias |
| 7 | Simulação gera relatório e não apaga | Exclusão exige backup < 24 h + aprovação + piso legal; flag off em produção = teste de configuração | Só com unidade fictícia em PG efêmero |

**Unidade fictícia:** só no PG efêmero/cópia, com dados sintéticos em todas as tabelas com RLS, chaves nos dois lados, `lead_manager_active=true` **apenas lá**. Se algum dia for preciso em produção: `ativo=false`, `lead_manager_active=false`, sem credenciais, e remoção com aprovação humana (é DELETE).

**T-RESTORE-01**, em container separado com rede isolada:
- restaurar globals + dump;
- contar todas as tabelas × contagens tiradas junto com o dump (`pg_dump --snapshot` ou logo depois, com tolerância);
- `jit`, `work_mem` e `search_path` presentes;
- decifrar certificado e credencial da Extranet só por script, sem subir servidor;
- amostra de 50 `media_url` de `messages` existindo no backup de uploads, com checksum;
- LM `/health` 200 com crons neutralizados.

### C.3 Smoke test pós-deploy de Valinhos (só leitura, ≤ 5 min, automatizável, aborta se qualquer item falhar)

1. `docker ps`: os dois containers `healthy`. Label/tag da imagem = SHA esperado. Grep do marcador em `/app/src`.
2. LM `/health` 200; `https://agenda.leovecchi.com/login` 200.
3. Logs dos últimos 10 min: **0** ocorrências de `permission denied|invalid input syntax for type uuid|current transaction is aborted|row-level security|ECONNREFUSED`, e 0 respostas 5xx em `/webhook`.
4. Sonda no banco como `postgres`: contagens de Valinhos ≥ pré-voo em `leads`, `conversations`, `messages`, `service_account`, `person`, `bi_raw.transactions`, `compasso.titulo`. Impressões digitais (`[removido]`, `anonimizado_`, `professor_nome IS NULL`) = pré-voo.
5. Sonda RLS como `lead_manager_user`: contexto antigo de Valinhos dá as mesmas contagens do pré-voo; contexto vazio dá 0 sem erro.
6. API com service token: inbox lista 200, primeiros 50 ids iguais ao pré-voo exceto o topo com atividade nova, latência ≤ 1,3× o baseline; `/leads` 200; DRE do mês e Folha do mês **iguais** ao pré-voo (se o ETL não rodou no meio).
7. Estado da instância Evolution = `open` (leitura).
8. `crontab -l` idêntico ao salvo; nenhum `docker exec` pendurado.
9. Da Fase 4 em diante: `portao_log` recebendo linhas.

---

## D) Fatiamento em janelas

### D.1 Dia útil, sem tocar produção

- **Código atrás de flag desligada**, um PR por item, em **worktree isolado a partir de `origin/main`** (nunca na árvore compartilhada):
  - `withUnidade`, `pode_rodar`, manifestos, gerador de catálogo;
  - script de contagem com impressões digitais;
  - guardas R1–R5 em modo só-log;
  - scripts de migration + reversão por passo;
  - script de "rodar imagem X" para os dois apps.
- **Testes** em PG efêmero (C.1/C.2).
- **Com aprovação do Leo, só leitura na VPS:**
  - `crontab -l`, `backup.sh`, `df -h`;
  - `pg_policy`/`pg_class` (inventário de RLS e colunas), tamanhos, `pg_stat_activity` típico;
  - histograma de mensagens por dia-da-semana × hora (para escolher a janela);
  - EXPLAIN baselines sob o role;
  - horário real do cron (X4); onde fica o banco do Evolution;
  - consulta R1 em modo leitura; log do backfill R5 (F0-4);
  - `SELECT min(received_at) FROM messages WHERE source='historico'`.
- **T-RESTORE-01** em container isolado numa noite de dia útil (lê o arquivo do dump e não escreve em produção), **com aprovação** por usar recurso do host.

### D.2 Janelas de fim de semana

Proposta **domingo 13:00–19:00 BRT**, a confirmar pelo histograma. Motivos: escola fechada; fora do ETL (22h–08h), do pg_dump, da madrugada de scrapes (02h–06:15), do sweep (08h) e do auto-envio (10h). Hard stop 19:00: se não terminou, reverte.

**Pré-voo comum a toda janela (falhou = NO-GO automático):**
1. SHAs congelados e `git log prod..alvo` revisado e aprovado; freeze avisado às outras sessões (financeiro 114, boas-vindas).
2. `docker tag` das imagens atuais como `pre-<janela>`.
3. `crontab -l > /root/crontab.pre-<janela>` e crontab da janela instalado.
4. Dump sob demanda + restauração rápida em container isolado + contagem OK (≤ 30 min).
5. Nenhuma transação > 60 s; nenhum `docker exec` de cron rodando; Evolution `open`.
6. Smoke (C.3) verde **antes** de começar (baseline da janela gravado em arquivo).
7. Humano de plantão por WhatsApp.

**Paradas automáticas (qualquer uma → rollback do passo e fim da janela):**
- smoke vermelho;
- lock esperando > 5 s após 3 tentativas;
- erro de migration;
- contagem ou impressão digital divergente;
- p50 de rota quente > 1,3× o baseline;
- comando bloqueado ou sem resposta > 10 min;
- qualquer passo fora do runbook ("não improvisar");
- passou das 19:00.

| Janela | Escopo fechado | GO / NO-GO | Duração | Aprovação humana |
|---|---|---|---|---|
| **J0-A** (dom 20/09) | backup v2 (globals, uploads, `.extranet-session`, cópia fora da VPS, segredos separados); cron da contagem (só leitura → arquivo); mitigação de R1 conforme decisão; esconder "excluir franquia" (deploy do dashboard) | GO: T-RESTORE-01 verde; decisão R1 registrada; destino fora da VPS definido | 2–3 h | **Leo:** R1, destino do backup, custódia de segredos |
| **J0-B** (dom 27/09) | Guardas R2–R5 **só-log** (deploy LM + dashboard); pré-voo de R1 para 01/10 | GO: replay normal = idêntico; itests verdes. Depois: 7 dias com 0 disparo em dia normal antes de ligar a guarda (outra janela, 1 flag por vez) | 2 h | Leo: F0-4 (R5 retoma ou não) |
| **J1-A** (≥ 04/10) | Migr. 127 **sem policies**: schema, `unidade`/`unidade_chave`, seed, **GRANT USAGE + SELECT**, CHECK de formato | GO: Fase 0 pronta (7 dias de contagem limpa, §7 contido); seed conferido | 30–45 min | Leo confere a tabela de chaves |
| **J1-B** | 2ª policy **só nas tabelas do 1º consumidor**, uma transação por tabela, `lock_timeout 3s`, sonda após cada lote, tabelas quentes por último | GO: T-RLS-01..06, T-PERF-01, T-LOCK-01 e T-ROLLBACK-01 verdes na cópia restaurada | 1–2 h | Leo aprova a lista de tabelas |
| **J2** | 128–129 (tabelas novas), seed de assinaturas `legado`, catálogo; teste do catálogo como **aviso** | GO: lista do Leo; ≥ 7 dias de J1 sem incidente | 1 h | **Leo:** assinaturas e classificações duvidosas |
| **J3** | 130 + `ultima_sync_ok` (transação própria) nos jobs | GO: T-F3 (falha não aborta) | 2 h | — |
| **J4.n** | 131 + `pode_rodar` em sombra (1 deploy por repo); **depois**, uma janela por remoção de valor fixo e por loop (com dry-run comparado) | GO: T-GATE-01/02; replay idêntico | 1–2 h cada | Leo por PR de valor fixo |
| **J5.n** | Ligar a flag de **um** job (alerta → envio → sync), 48 h de observação | GO: 14 dias com 100% `rodaria` | 30 min + 48 h | **Leo, cada flag** |
| **J6** | Derivação E1/E2 valendo | GO: 14 dias de sombra sem divergência | 2 h, **humano presente** | **Leo presente** |
| Fase 7 | Só deploy do código desligado + teste de configuração (flag off) | — | 30 min | **Exclusão nunca pelo agente** |

**O agente não pode fazer sozinho:**
- decisão R1;
- lista de assinaturas e classificação do catálogo;
- destino do backup e guarda de segredos;
- ligar qualquer flag de portão (Fase 5) e a Fase 6;
- qualquer DELETE/DROP fora do script de reversão aprovado;
- unidade fictícia em produção;
- merge de trabalho de outra sessão;
- restaurar dump como rollback;
- qualquer coisa da Fase 7.

---

## E) O que o ADR ainda não especifica bem

1. **Grants e RLS de `plataforma`:** falta USAGE no schema (C1). Não diz se `assinatura`, `cobertura`, `portao_log` e `contagem_referencia` têm RLS nem com qual variável (F1-6).
2. **2ª policy:** qual repositório/numeração aplica a policy em tabelas de schema do scheduler; nome da policy; lista exata (introspecção); colunas heterogêneas (F1-2); FOR ALL × SELECT e WITH CHECK para escrita via `withUnidade`; como tabelas futuras ganham a policy (F1-4). Recomendo **não aplicar em todas as tabelas de uma vez**.
3. **Onde vivem as "flags por job"** (env exige restart; tabela não está na DDL).
4. **Semântica de erro de `pode_rodar`** (falha aberta × fechada) e a contradição com `requireModulo` falhando fechado (F5-1 × requisito 1). Também: cache e custo no tick de 60 s, retenção/índice do `portao_log`, `unidade_id NOT NULL` antes de a unidade ser resolvida.
5. **"Idêntico" não está definido na prática:** tolerâncias, replay, o que é determinístico (seção B deste documento).
6. **Homologação inexistente** e "unidade fictícia em homologação" sem lugar (X10). Os testes atuais usam o banco de produção (C7).
7. **Procedimento de migration:** sem ledger, sem `--single-transaction`, sem `lock_timeout`, sem script de reversão por fase (as Fases 2–4 dizem só "nada lê ainda"); numeração duplicada no scheduler.
8. **Rollback de código:** o deploy do dashboard não tem volta para a imagem anterior (X1); "restaurar dump" não pode ser rollback (X2); RPO/RTO não definidos.
9. **Contagem de referência:**
   - coluna de data por tabela;
   - chave de unidade para tabelas sem tenant (`app.*` por `franquia_id`, filhas de `investments`);
   - classes de queda esperada;
   - detecção de UPDATE destrutivo (X9);
   - qual número e qual instância recebem o alerta no WhatsApp (anti-ban).
10. **Backup:** globals (roles, `ALTER ROLE`, `ALTER DATABASE jit=off`), banco do Evolution, PITR, periodicidade da cópia fora da VPS, teste de restauração recorrente.
11. **Janela operacional:** nenhuma janela de manutenção definida; nenhum procedimento de pausa de cron (host, node-cron do LM sem flag, orchestrator só via restart); fuso real do crontab (X4); conflito com o pg_dump.
12. **§7 com dados a corrigir:**
    - R5 cita 263-285, mas o SQL está em `backfill-sa-enriquecimento.js:10-32`, e **o job provavelmente não faz nada desde a migr. 074** (F0-4);
    - R2 não está agendado;
    - a proposta de upsert + `fonte_ausente_em` em R2/R3 **muda o dia normal** e precisa da lista de leitores (F0-1);
    - R4 "inativar em vez de apagar" também muda os leitores da grade.
13. **Fase 4.2:** não diz como comparar saída antiga × nova sem raspar e gravar em dobro (F4-1).
14. **D10 × requisito 3:** apagar credencial na hora é irreversível por desenho. Precisa de exceção assinada pelo Leo.
15. **Comportamento do Evolution com webhook lento ou travado** (reenvia?). Define se lock de DDL pode perder mensagem (C2).
16. **Governança do documento e das sessões:**
    - o ADR não está commitado e diz "Proposto" apesar de aprovado;
    - dois clones do scheduler divergentes;
    - ordem com a migr. 114 do financeiro e com as 120–125 das boas-vindas diante do teste do catálogo;
    - quem tem autoridade para abortar na janela e por qual canal.
17. **Fase 1, "demais franquias":** quais existem, quais têm dado real e qual é o tratamento das franquias sem `bi_tenant`/`lead_tenant`.

**Arquivos principais:**
- `C:\dev\adr-lead-manager\src\db.js`, `src\jobs\dataRetention.js`, `src\anonymize.js`, `src\server.js`, `src\resources\sync.js`, `src\resources\daily-sync.js`, `src\gating.js`, `src\engine.js`, `src\routes\tenant.js`, `db\migrations\001_init_lead_manager.sql`, `db\migrations\034_classifier_shadow.sql`, `deploy\crontab.*.txt`, `test\gate-isolation.test.js`, `test\gating.test.js`, `test\run-renovacao-itest.sh`
- `C:\dev\adr-whatsapp-scheduler\dashboard\lib\db.js`, `lib\auth.js`, `lib\cancelamentos.js`, `lib\qualidade-db.js`, `lib\orchestrator.js`, `lib\bi-etl-extranet.js`, `lib\campanha.js`, `lib\bi-financas.js`, `scripts\backfill-sa-enriquecimento.js`, `scripts\scrape-status-alunos.js`, `routes\admin.js`, `C:\dev\adr-whatsapp-scheduler\db\migrations\074_bi_raw_rls.sql`, `db\apply-migration.sh`, `db\checks\auditoria-fase0-baseline.sql`, `deploy-dashboard.sh`