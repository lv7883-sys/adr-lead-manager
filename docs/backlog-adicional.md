# Backlog adicional — derivado do ADR-003

> Itens **abertos pelo ADR-003** (classificação, triagem e convivência).
> Não fazem parte do escopo original das epics E6/E7; registrados aqui para
> não perdermos o rastro. IDs marcados como *(proposto)* ainda precisam de
> triagem/priorização formal.

## Stories de implementação

| ID (proposto) | Story | Origem (ADR-003) | Prioridade | Notas |
|---|---|---|---|---|
| **E8-01** | Tabela `known_contacts` por tenant (RLS) + CRUD admin | Decisão 2 (A+C) | Alta | Portão 0 do funil; bloqueia o risco crítico de falso positivo. Schema esboçado no ADR §4. |
| **E8-02** | Job de sync periódico da extranet/CRM → alunos matriculados em `known_contacts` | Decisão 2 (A) | Alta | Mitiga staleness; definir frequência e fonte. Depende de E8-01. |
| **E8-03** | Classificador leve (Gemini Flash) com prompt de triagem curto + saída estruturada `{label, confidence, reason}` | Decisão 1 (cascata B→A) | Alta | Portão 1. Threshold inicial conservador (alto). |
| **E8-04** | Métricas de precisão/recall do classificador + instrumentação de decisão | Decisão 1 e 4 | Alta | Pré-requisito para graduar segmentos do modo observação → automático. |
| **E8-05** | Fila de aprovação + console da recepcionista (aprovar/editar antes do 1º envio) | Decisão 4 (A) | Alta | Habilita o **go-live em modo observação total**. |
| **E8-06** | Atribuição de proveniência (deep links `wa.me`/UTM, origem de campanha) | Decisão 4 (C) | Média | Dependência externa: instrumentação no **Marketing**. Habilita caminho automático. |
| **E8-07** | Lock de *ownership* de conversa (`conversation_owner`: lead_manager \| scheduler) | Decisão 3 | Média | Garante respondedor único na borda; rede de segurança sobre domínios disjuntos. |
| **E8-08** | Fan-out de webhook / config de múltiplos webhooks no provider (LM + Scheduler) | Decisão 3 | Média | Operacional/deploy. Dispatcher stateless OU multi-webhook nativo do provider. |
| **E8-09** | Abstração `ChannelAdapter` (`parseInbound`/`sendOutbound`) sobre o `normalizeMessage` atual | Decisão 5 | Baixa | Abstração fina, validada só com WhatsApp no MVP. Sem conectores FB/IG/Google. |

## ADRs futuros (decisões adiadas explicitamente)

| ID (proposto) | Tema | Origem (ADR-003) | Notas |
|---|---|---|---|
| **ADR-004** | Contrato de *ownership* de conversa do lado do **Scheduler** | Decisão 3 (risco residual) | Hoje a precedência é aplicada só pelo LM (ele se cala). Fechar o ciclo no Scheduler. |
| **ADR-005** | Identidade unificada de contato **cross-canal** (mesma pessoa em WhatsApp/IG/…) | Decisão 5 (risco residual) | Adiar até existir o 2º canal. Deduplicação de pessoa. |

## Dependências externas levantadas
- **Marketing:** instrumentação de proveniência (deep links/UTM) — bloqueia E8-06 e, por consequência, a graduação do caminho automático.
- **Extranet/CRM:** endpoint/credenciais para o sync de alunos — bloqueia E8-02.
- **Provider WhatsApp (Z-API/Evolution):** suporte a múltiplos webhooks ou necessidade do fan-out — E8-08.

---
_Gerado a partir do ADR-003 (2026-06-01). Atualizar conforme as stories forem trianguladas no planejamento._
