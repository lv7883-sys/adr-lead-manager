# ADR-040 — Plantão diário (card de saúde + resumo noturno)

## Gatilho
Fase piloto com vários sistemas em shadow/on (bola, filtro por papel, reativação, cron de cadastro, scrape). O operador **não deve abrir telas pra vigiar**. Precisa de um resumo **1×/dia**, trivial de ler, que só chame atenção quando algo destoa.

## Tese
Um **agregador de saúde** que **NÃO cria captura nova** — só lê os logs que já existem — e expõe o resumo em dois lugares: um **card no dashboard** (o operador vê ao logar) e um **resumo noturno** (cron, via hook de ops). Semáforo verde/amarelo/vermelho por sistema. Verde = nada a fazer.

## Fonte (só leitura de log)
| Sistema | Lê de | Números do dia | Semáforo |
|---|---|---|---|
| **Bola** (ADR-030) | `bola_shadow_log` + `field_provenance` (revert de `conversation_state`) | N decisões · M revertidas | verde (obs); mostra modo shadow/on |
| **Filtro** (ADR-036) | `gate_shadow_log` + `messages.discarded='role_hard'` + `classification_feedback` (gate_revert) | N descartes · M revertidos | **amarelo** se houve FP (would-hard ∩ crivo=lead) |
| **Reativação** (ADR-027) | `reabordagem_tentativas` | N retomadas · M reengajaram | verde (mostra o que há; ver dívida #8) |
| **Cadastro sync** (ADR-037) | `cadastro_sync_log` (último run) | novos · mudados · sumidos | verde=OK fresco · **amarelo**=SAFEGUARD/stale(>26h) · **vermelho**=ERROR/CREDENTIAL |
| **Scrape** | `cadastro_sync_log` status ERROR/SAFEGUARD (48h) | última falha login/block | **vermelho**=CREDENTIAL · amarelo=transiente |

`resumoPlantao(tenantId)` (`src/plantao.js`) devolve `{ pior, systems:[{status,numeros,detalhe,link}] }`. **Multi-tenant** (recebe tenantId, sem hardcode). **Custo:** ~6 SELECTs de contagem/tenant — ínfimo. Cada query é best-effort (tabela ausente → sistema omitido, não quebra).

## Card "Plantão"
Vive na **home** (`recep-home`, o operador vê ao logar — sem abrir tela). 1 linha/sistema: bolinha de status + rótulo + números + detalhe. **Verde = nada a fazer**; amarelo/vermelho **clicam** e vão pro Monitor da aba certa (link de fundo). Buscado pela rota da home com **timeout curto (2s) + fallback null** (a landing não pendura; se o LM degradar, o card só não aparece).

## Resumo noturno (cron)
`src/jobs/plantao-noturno.js` — itera `tenants_active()`, monta o MESMO `resumoPlantao`, manda via **hook de ops** (molde do `notifyOpsHook`): hoje = **log de alta visibilidade** `plantao.resumo` (`alert:true` quando algo destoa; verde = 1 linha/sistema). **PLUGAR canal real** (WhatsApp ops/e-mail) quando existir — mesmo TODO dos outros alertas. Cron do **HOST às 21:00 BRT** (`deploy/crontab.plantao.txt`), longe dos outros (03h backup/resources, 04h cadastro); só leitura, sem Extranet/lock.

## Não-objetivos / dívida
- **Sem migração** — só leitura de log; nenhuma tabela nova.
- **Reativação** mostra `reabordagem_tentativas` cru; a métrica "reengajou" fica correta quando a dívida do diag #8 entrar (retomada por `/approve` não grava em `reabordagem_tentativas`).
- **Canal real de ops**: hoje é log; plugar depois (comum a ADR-020/026/036).
- **Card na home é fetch inline** (2s timeout): se quiser 100%-não-pendura, virar fetch async client-side (refinamento futuro).

## Reversível
`git revert` + `DROP` da linha do crontab. Aditivo puro (nenhuma escrita nova, nenhuma migração).
