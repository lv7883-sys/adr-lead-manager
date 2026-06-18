# Spec — Contato ↔ Oportunidade (dois tiers de contato)

> Spec de design derivada do mapeamento e das decisões desta sessão (jun/2026).
> Não introduz decisão nova: registra o modelo acordado.

## 1. Problema

O pipeline trata "é lead / não é lead" como binário e usa `internal_contacts` como
**hard-exclude** (Gate 0 descarta antes de classificar, `engine.js:333`). Isso é certo para
ruído operacional (equipe), mas **errado para professores/clientes**: eles conversam pela
escola e são **fonte de oportunidade** (indicam alunos, voltam a contratar, novos filhos).
Excluí-los apaga relacionamento. Grupos, por outro lado, **nunca** são lead.

## 2. Dois tiers de contato

| Tier | Quem | Tratamento |
|---|---|---|
| **Operacional / staff** | gestor, recepcionista, funcionário, fornecedor/parceiro interno | **Hard-exclude** (Gate 0 / `internal_contacts`): não vira lead, não classifica. |
| **Relacionamento** | professor, cliente, aluno, responsável | **NÃO exclui** — é contato conhecido E fonte de oportunidade. Não entra em `internal_contacts`. |

**Decisão desta sessão:** professor saiu do hard-exclude. O sync
`professor → internal_contacts` foi revertido (DELETE dos 22) e o script removido. Os
14 leads-professor + 10 leads-grupo receberam **soft-exclude corretivo**:
`status='NOT_LEAD'`, `review_queue=false`, `review_result='confirmed_not_lead'`, com o
rótulo fino em `classification_reasoning` (`[corretivo] relationship_professor` /
`[corretivo] group`) e snapshot em `bkp_corretivo_falsos_20260618`. Saem do funil e do
/unclassified, **rescue bloqueado** (exige `review_result IS NULL`), seguem ingerindo
mensagem e **recuperáveis**. Grupos são hard-excluídos já na ingestão (ver §5).

> Nota: hoje `review_result` tem CHECK que só aceita `confirmed_lead`/`confirmed_not_lead`.
> O rótulo de tier/relacionamento ficou em `classification_reasoning` + snapshot. Tipar de
> verdade (tabela de contato com `tier`/`type`) é trabalho do modelo abaixo.

## 3. Modelo contato ↔ oportunidade

Hoje "contato" = telefone normalizado no lead/mensagem; **não há entidade de contato**.
O modelo alvo:

```
contato (1) ───< (N) oportunidade
```

- **1 contato → N oportunidades tipadas.** Um professor pode gerar uma indicação hoje e
  uma rematrícula daqui a um ano; cada uma é uma oportunidade própria, sem apagar o
  contato nem confundir com a anterior.
- O **tier/tipo do contato** (operacional vs relacionamento; professor/cliente/aluno) é
  atributo do contato, não do lead.
- A **oportunidade** carrega o estado de funil (qualificando…convertido/perdido) e a
  intenção tipada (ver saída tipada em
  [spec-classificador-upgrade.md](spec-classificador-upgrade.md)).
- Hard-exclude (staff) = contato sem oportunidades. Relacionamento = contato que **pode**
  abrir oportunidades.

## 4. Match de contato

Chave: **telefone normalizado com DDI 55** (`regexp_replace('[^0-9]') ` + prefixo `55` em
10/11 díg — a mesma regra do `_normalizaTelefoneBR` e do Gate 0). Foi a normalização que
revelou os 15 professores-lead (o match exato sem 55 escondia). Validação desta sessão:
os 14 matches tinham telefone **idêntico** (zero colisão); a divergência era só
nome-curto/apelido (pushName) vs nome completo cadastrado (ex.: "Tom" = Thomas de Brito
Soares). Logo o telefone-55 é chave confiável; o nome **não** serve de match.

## 5. Grupos

JID de grupo (`@g.us`, ids `120363…`, ≥16 díg) **nunca** é lead, em nenhum tenant —
hard-exclude genérico na ingestão. Implementado em `src/routes/webhook.js` (commit
`b29ecb9`): flag `isGroup` em `normalizeMessage` (Evolution e Z-API) + guard em
`handleZapiWebhook` antes de qualquer ingestão (não cria lead nem captura staff_sample).

## 6. Generalização — CRM multi-tema por tenant

O mesmo mecanismo serve além de "escola de música → aula": o **tier de contato** e os
**tipos de oportunidade/intenção** são **dados configuráveis por tenant**, não código.
Um tenant define seus tipos de relacionamento (professor/aluno/responsável) e seus tipos
de oportunidade (matrícula, rematrícula, indicação, evento). O motor (ingestão, match por
telefone-55, classificação context-aware, funil de oportunidade) é genérico; o vocabulário
é ADR/tenant por cima.

## Referências de código / dados
- `src/engine.js:333` (Gate 0 hard-exclude internal_contacts)
- `src/routes/webhook.js` (`isGroup` + guard de grupo, commit `b29ecb9`)
- `app.professor_notificacao` (fonte de telefones de professor, franquia→tenant)
- snapshots: `bkp_corretivo_falsos_20260618` (soft-exclude prof+grupo),
  `bkp_latch_remediacao_20260618` (remediação do latch)
