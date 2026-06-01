# ADR-006 — Centro de controle de automação (por tenant)

- **Status:** 🚧 **PENDENTE — não implementado** (placeholder para revisão futura)
- **Data:** 2026-06-01
- **Autor:** ATLAS (arquitetura) — rascunho de escopo
- **Relacionados:** ADR-003 (funil de triagem, modo observação, rollout faseado),
  ADR-004 (roles, gating de assinatura), E1-01/02/03 (motor), E9-05 (gating),
  E9-06 (namespace `/tenant/:id/*`)

> ⚠️ Este documento **registra escopo para revisão**, não uma decisão tomada.
> Nada aqui está implementado. Não usar como referência de comportamento atual.

---

## 1. Contexto / motivação

O ADR-003 estabeleceu o **modo observação** (o Lead Manager sugere, a recepção
aprova; nada é enviado automaticamente) e um **rollout faseado** em que segmentos
de maior confiança seriam "graduados" para resposta automática. Hoje isso é
binário e global (tudo em observação).

Este ADR propõe um **centro de controle de automação por tenant**: granularizar
*o que* é automatizado e *com qual nível de autonomia*, para que cada unidade
gradue a automação no seu ritmo, sem mudança de código.

---

## 2. Escopo proposto (a detalhar)

### Tipos de ação configuráveis por tenant
1. **Resposta a lead novo** (WhatsApp orgânico)
2. **Resposta a lead com proveniência rastreável** (landing/anúncio/deep link)
3. **Follow-up automático 24h** (sem resposta do lead)
4. **Reativação de lead frio** (status `COLD`)
5. **Reativação de ex-aluno** (`former_student`)

### Níveis de autonomia (por ação)
- **MANUAL** — o Lead Manager **não** age sozinho; no máximo registra/sugere sob
  demanda. Sem automação.
- **SEMI** — gera a resposta sugerida e cria `pending_approval`; **a recepção
  aprova antes de enviar** (= comportamento atual / modo observação do ADR-003).
- **AUTO** — envia automaticamente, sem aprovação humana.

### Configuração
- Por tenant, via **`/tenant/:id/automacao`** (namespace self-service do E9-06;
  autorização `TENANT_ADMIN` + `PLATFORM_ADMIN` por impersonation).
- **Default para todos os tenants: `SEMI`** em todas as ações — preserva o
  comportamento atual (modo observação) sem migração de dados.

---

## 3. Pontos em aberto (a decidir na implementação)

- **Modelo de dados:** tabela `tenant_automation_settings(tenant_id, action,
  level)` (RLS) ou JSONB único por tenant? Default `SEMI` resolvido por código
  vs. seed por linha.
- **Pré-requisitos de cada ação:** ações 2–5 dependem de sinais que ainda não
  existem — proveniência (ADR-003 Decisão 4 / backlog E8-06), status `COLD` e
  `former_student` no lead (não modelados), e o motor de follow-up 24h
  (scheduler/cron). Sem esses, só as ações 1 e (parte da) 3 são viáveis a curto
  prazo.
- **Interação com o gating de assinatura (E9-05):** `AUTO`/`SEMI` só valem se a
  feature estiver `ACTIVE`/`TRIALING`; `GRACE`/`EXPIRED` continuam barrando tudo.
- **Envio automático (`AUTO`):** exige o caminho de envio via Z-API (hoje só há
  notificação à recepção; o envio real ainda não está implementado) + lock de
  ownership da conversa (ADR-003 Decisão 3).
- **Auditoria:** toda mudança de nível e todo envio `AUTO` deveriam ser
  auditados (consistente com a auditoria de impersonation, ADR-008 reservado).
- **Salvaguardas:** o Portão 0 (`known_contacts`) tem precedência sobre qualquer
  nível — gestor/aluno/fornecedor conhecido nunca dispara automação, mesmo em
  `AUTO`.

---

## 4. Próximos passos (quando priorizado)
- Promover este placeholder a ADR completo (opções/trade-offs/decisão por tipo de
  ação e nível).
- Abrir E-stories: modelo `tenant_automation_settings` + endpoint
  `/tenant/:id/automacao`; sinais faltantes (proveniência, `COLD`,
  `former_student`); motor de follow-up 24h; caminho de envio `AUTO` + ownership.
- Resolver a numeração de ADR (ver nota no `backlog-adicional.md`).
