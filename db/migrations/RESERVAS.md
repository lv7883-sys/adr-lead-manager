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
| **131** | **ADR-051 / coleta** | cache de páginas já lidas da Extranet (retomada da coleta de cadastro) | não — pronta para aplicar |
| 132–139 | ADR-051 | Núcleo canônico (unidade, aplicacao, assinatura, grupos de dados) | não |
| 140–149 | ADR-052 | Implantação guiada | não (arquivos ainda não criados) |
| 150–169 | ADR-051 | continuação do núcleo canônico | não |
| **170–174** | **atribuição + plataforma** | 170 mapa_campanha, 171 origem_lead, 172 plataforma, 173 marketing, 174 privilégios da origem | **SIM — aplicadas em 21/09/2026** |
| **175** | **ingestão de mídia** | 175 grupo_fonte + raw_asset (matéria-prima vinda do grupo de WhatsApp) | **SIM — aplicada em 22/09/2026** |
| **176–177** | **sugestão de IA / aprendizado** | 176 sugestao_ia, 177 aprendizado_le_campanha | sim |
| **178–181** | **funil / leads** | 178 fecha matrículas, 179 view contrato × origem, 180–181 interesse do beneficiário | **SIM** (aplicadas) |
| **182–183** | **funil / leads** | 182 devolve NOT_LEAD com contrato novo (Carla, Ronaldo, Nínive), 183 marca o contrato de teste da recepção | **SIM** (01/10/2026) |
| **184** | **agenda de contatos** | 184 contato_agenda (o nome do contato como a unidade salva — pedido do Leo 05/10/2026) | **SIM — aplicada em 05/10/2026** |
| **185** | **boas-vindas** | 185 data_matricula no contrato (âncora da régua = matrícula, não início das aulas) | não — pronta para aplicar |
| **186** | **boas-vindas** | 186 boas_vindas_inclusao (a recepção inclui quem a régua deixou de fora) | não — pronta para aplicar |
| **187** ⚠ | **demonstração MF8 — E COLIDE** | 187 `is_demo` em `lead_manager.tenants` — portão do seed da unidade de demonstração (apresentação de 04/11/2026). ⚠ **O ramo `feat/metricas-prova-receita` reservou 187 para `metricas.reativacao_mensal`** e escreveu a linha só lá. Duas frentes, o mesmo número, nenhuma das duas aplicada. Ver o aviso abaixo | não — pronta para aplicar |
| **188** ⚠ | **kanban por unidade — E COLIDE** | 188 `stage_ui` em tenant_lead_config + `etapa_custom` em leads — renomear, esconder e acrescentar coluna (pedido do Leo 02/11/2026). ⚠ **O mesmo ramo reservou 188 para `metricas.matricula_origem`.** Ver o aviso abaixo | não — pronta para aplicar |
| 189–190 | livre no `main` | ⚠ reservados no ramo `feat/metricas-prova-receita` (189 `metricas.renovacao_mensal`, 190 `plataforma.modulo_golive`) — confirme com aquela frente antes de pegar | — |
| **191** ⚠ | **reabordagem (outra frente)** | `191_reabordagem_fila_nao_e_resultado.sql`, no ramo `claude/reabordagem-fonte-unica-b11b4a` — **não mergeado**. Aquela frente renumerou de 187 para 191 (commit `fbac824b8`) e não escreveu a linha aqui; esta linha foi escrita por terceiros em 16/11/2026, varrendo os ramos, **não** por quem é dono dela. ⚠ O número 191 também já foi usado e devolvido nesta mesma série: `191_site_contato.sql` nasceu no ramo `feat/metricas-prova-receita` e saiu no revert `81b1b0a03` — nunca foi aplicada | **não** — confirmar com a frente da reabordagem |
| **192** | **aviso de lead novo** | `lead_manager.ingestao_latencia` — o cronômetro da entrada: quanto tempo entre o webhook chegar e o lead existir. Instrumento de MEDIÇÃO com prazo de validade (ver o cabeçalho do arquivo): depois da decisão do aviso "no instante" (`docs/proposta-aviso-lead-novo.md`, D2), ou ganha dono e retenção, ou é apagada. Não guarda telefone, nome nem texto. **Nasceu como 191 e foi renumerada no mesmo dia**, ao descobrir a colisão acima — renumerar antes de aplicar é barato, depois não | **SIM** — aplicada e verificada no banco em 17/11/2026 (tabela, RLS forçada, política e privilégio conferidos um a um; append-only PROVADO sob a ROLE da aplicação, com controle positivo) |
| 193–199 | livre | — | — |

> 🔴 **16/11/2026 — a tabela dizia "191–199 livre" e 191 estava tomado por dois arquivos diferentes.**
> O método que achou isso é o que esta tabela já recomenda e quase ninguém roda, então vale repetir:
> `git log --all --diff-filter=A --name-only --format="" -- 'db/migrations/*.sql'` **não basta** —
> ele não mostrou o arquivo do ramo da reabordagem. O que mostrou foi varrer os ramos um a um:
> `for b in $(git branch -a --format='%(refname:short)'); do git ls-tree -r --name-only "$b" -- db/migrations/; done`.
> Conferir só o disco e só o `main` teria deixado a colisão passar.

## Nome do contato: a fonte é `lead_manager.contato_agenda` (184)

Quem precisar do nome de um contato **lê a régua** `src/contato-nome.js` (ordem: agenda da unidade >
pushName > cadastro > lead > número) — não reimplemente o COALESCE, que já esteve copiado em quatro
lugares. **`qualidade.inbox_contato_nome` está APOSENTADA** (05/10/2026): tinha 0 linhas, a chave era
telefone em dígitos crus e o nome era sobreposto em memória no dashboard, fora do alcance da busca.
Não escreva nela. E `lead_manager.known_contacts` (migr 004) é outra coisa: é o portão de triagem
(STAFF/STUDENT/SUPPLIER), não tem coluna de nome, segue vazia e não é lida — não fundir as duas.

⚠ O nome da agenda é **campo livre com anotação interna** ("Fulana - filhos X e Y, - Teclado"). Hoje
nenhum caminho de ENVIO o consome (autoReply usa pushName, campanha manda só número). Se for montar
texto que alcança o cliente, use um campo com o primeiro nome limpo — nunca este. Mesma família da
regra "nunca usar nome de recepcionista em texto que vai ao cliente".

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
