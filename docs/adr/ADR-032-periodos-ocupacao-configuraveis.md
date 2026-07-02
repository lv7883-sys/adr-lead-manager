# ADR-032 — Períodos de ocupação configuráveis por tenant
**Status:** Aceito | **Data:** 2026-07-02
**Contexto:** Dashboard de ocupação (Bloco B). A média do dia inteiro engana (mistura pico com hora morta — recon da bateria provou: Bonham 16h=100% vira "30%" no dia). A solução é medir por período (manhã/tarde/noite/sábado), e os períodos precisam ser config de tenant, não hardcode.

---

## Tese central

Dividir o dia em períodos resolve o denominador enganoso (média por período não mistura pico com hora morta). Mas as faixas de período **não são regra da plataforma** — variam por tenant e por ramo: uma escola de música tem noite cheia (18-21h), uma academia de ginástica tem pico 06h, uma clínica tem outras faixas. Portanto período é **config-as-data por tenant**, mesma família do `horario_comercial`, das faixas de funil, do vocabulário de ramo (ADR-030). Nada hardcoded pra Valinhos.

## Por que coluna nova (e não o jsonb existente)

`tenants.horario_comercial` roda `canonicaliza()` no PUT, que descarta qualquer chave fora de 1..7 (dias ISO). Um `periodos:{}` colado ali é apagado na gravação. Tocar o `horario.js` (fonte do SLA de atendimento) pra abrir exceção é arriscado. `resources.tenant_resource_config.working_hours` está dormente e com NOT NULL não-wired — casa ruim. Decisão: **coluna aditiva `tenants.periodos_ocupacao jsonb`** (espelha o padrão da migration 049 do próprio horario_comercial — aditiva, dado antigo intacto).

## Estrutura (multi-tenant desde o início)

Cada período = faixa de hora **+ dias a que se aplica**. Isso resolve o sábado (é um período que se aplica só ao dia 6) e deixa qualquer tenant configurar livremente:

```json
{
  "manha":  {"faixa":["09:00","12:00"], "dias":[1,2,3,4,5]},
  "tarde":  {"faixa":["12:00","18:00"], "dias":[1,2,3,4,5]},
  "noite":  {"faixa":["18:00","21:00"], "dias":[1,2,3,4,5]},
  "sabado": {"faixa":["09:00","13:00"], "dias":[6]}
}
```

Valinhos entra como **seed** (esses valores). Um segundo tenant define os seus. O dashboard **lê** as faixas do tenant e monta as grades em cima delas — nunca de constantes no código.

## Decisões

| # | Tema | Decisão |
|---|---|---|
| 1 | Onde mora | Coluna nova `tenants.periodos_ocupacao jsonb`, aditiva. Não no `horario_comercial` (canonicaliza apaga). |
| 2 | Estrutura | Período = `{faixa:[hh:mm,hh:mm], dias:[iso]}`. Sábado é período com `dias:[6]`. Nomes de período são chaves livres. |
| 3 | Seed | Valinhos: manhã 09-12 / tarde 12-18 / noite 18-21 (dias 1-5) + sábado 09-13 (dia 6). |
| 4 | Edição | Extensão pequena da tela de horário (`recep-horario-atendimento.js`) — sub-card "Períodos". Mesmo lugar do horário de atendimento. |
| 5 | Leitura | Dashboard lê `periodos_ocupacao`; se ausente, fallback razoável (não quebra). Denominador de ocupação usa a **faixa ativa do período**, nunca o dia cru (a correção que motivou tudo). |

## Fronteira

Este ADR cobre só a **config de períodos**. O cálculo de ocupação por célula, o filtro combinado e o gargalo (Bloco B do dashboard) são construção sobre helpers existentes (`grade.js`), sem decisão de schema — não precisam de ADR próprio, seguem o recon aprovado.

## Riscos

- Migration aditiva: backup antes, coluna nullable, sem tocar dado existente.
- Fallback: dashboard não pode quebrar se um tenant não tem `periodos_ocupacao` — usar default sensato e sinalizar.
- Nomes de período livres: o front não pode assumir exatamente "manha/tarde/noite/sabado" — iterar as chaves que vierem.
