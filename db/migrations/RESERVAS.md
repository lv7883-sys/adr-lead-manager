# Reservas de numeração — migrações do Lead Manager (`db/migrations`)

Esta é a série do **adr-lead-manager**. O `adr-whatsapp-scheduler` tem a própria série,
independente: um número 116 lá e um 116 aqui são arquivos diferentes e não conflitam.

**Regra:** antes de criar uma migração, pegue uma faixa livre aqui, escreva a linha na tabela
e avise as outras frentes. Reserva combinada só por conversa foi exatamente o que causou a
colisão de 20/09/2026 (faixa 140–149 ocupada por engano por duas frentes ao mesmo tempo).

| Faixa | Dono | Frente | Aplicada em produção? |
|---|---|---|---|
| 001–119 | histórico | várias (base, RBAC, ADR-016, ADR-029…) | sim |
| 120–126 | ADR-050 | Boas-vindas / onboarding do aluno | **sim** (16/09/2026) |
| 127–130 | funil/BI | devolve descartados, aula experimental, data do lead da Extranet | sim |
| 131–139 | ADR-051 | Núcleo canônico (unidade, aplicacao, assinatura, grupos de dados) | não |
| 140–149 | ADR-052 | Implantação guiada | não (arquivos ainda não criados) |
| 150–169 | ADR-051 | continuação do núcleo canônico | não |
| **170–174** | **atribuição + plataforma** | 170 mapa_campanha, 171 origem_lead, 172 plataforma, 173 marketing, 174 privilégios da origem | **SIM — aplicadas em 21/09/2026** |
| 175–199 | livre | — | — |

## Nomes já reservados dentro do schema `plataforma`

O ADR-051 reserva: `unidade`, `unidade_chave`, `aplicacao`, `assinatura`, `grupo_dado`,
`cobertura`, `portao_log`, `contagem_referencia`, `catalogo_objeto`. **Nenhum é criado pela
172** — ela cria só `credencial_unidade` e `consumo_evento`.

✅ **Resolvido em 20/09/2026 (decisão do Leo):** a fonte única de contratação é
`plataforma.assinatura` (ADR-051, D9). **Nenhuma frente cria tabela nova de licença** — a 172
chegou a ter `modulo`/`modulo_contratado` e foram removidas. Até a assinatura existir, a
resposta vem de `app.tenant_modules` por um ponto único de leitura
(`src/plataforma/licenca.js`), e a virada é uma consulta só. Ver `DECISIONS.md` D18.

## Tabelas escritas sem migração própria (avisar antes de mexer)

- `lead_manager.renovacao_dismiss` — gravada pela tela "Hoje" do dashboard (sessão do Diapasão)
- `lead_manager.service_account`, `account_member`, `person`, `contact_point` — lidas pelo dashboard
