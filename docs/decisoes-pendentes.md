# Decisões Pendentes de Revisão

## DP-001 — platform_reader BYPASSRLS

**Prazo:** 30 dias após go-live do piloto ADR Valinhos
**Decisão atual:** Calcular agregados iterando por tenant (sem BYPASSRLS)
**Revisar quando:** Volume de tenants > 20 ou queries de métricas globais demorarem mais de 2s
**Ação:** Avaliar se vale introduzir o papel platform_reader com BYPASSRLS read-only + pool separado
**Referência:** ADR-004, Decisão 2

## DP-002 — Notificações de trial para TENANT_ADMIN

**Prazo:** Fase 2 (primeiro cliente externo)
**Decisão atual:** Apenas Leo recebe notificações D-3/D-1/vencimento
**Ação:** Adicionar notificação ao TENANT_ADMIN do tenant com trial expirando
**Referência:** ADR-004, Decisão 4
