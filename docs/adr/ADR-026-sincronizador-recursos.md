# ADR-026 — Sincronizador de Recursos (ingestão contínua, multi-tenant)

- **Status:** ✅ **Aceito** (decisão de desenho — **NÃO IMPLEMENTADO**)
- **Data:** 2026-06-26
- **Autor:** sessão Claude Code (decisões de produto/arquitetura do Leo)
- **Relacionados:**
  - ADR-025 (gestão de recursos reserváveis; schema `resources`, `resource_source_binding`,
    `external_ref`, proveniência por toggle) — [[adr-025-gestao-recursos]]
  - ADR-008 (`ServiceBooking` / motor de agendamento nativo — fronteira de não-duplicação)
  - [[migration-046-resources-deploy]] (fatia recorrente já em prod)
  - [[extranet-agenda-datada-confirmada]] (endpoints e formato da Extranet)
  - [[extranet-rate-limit-allowlist]] (fragilidade / 429 da Extranet)
  - `src/crypto.js` (AES-256-GCM, `LM_ENCRYPTION_KEY`) — mecanismo de cifragem reusado

> ⚠️ Este documento **registra a decisão de desenho**, não comportamento implementado.
> Nenhum sincronizador, tabela, migration ou código de app existe a partir deste ADR.
> Não usar como referência de comportamento atual.

---

## 1. Contexto / motivação

O **ADR-025** modelou as **tabelas** de recursos (schema `resources`; a fatia recorrente
já está em produção via **migration 046** — [[migration-046-resources-deploy]]). Mas o
ADR-025 **não decidiu COMO os dados entram e se mantêm vivos**.

Um **seed estático é um retrato que envelhece**: se um professor é cadastrado,
**reativado** ou **desligado** na fonte (a Extranet, no caso de Valinhos), o catálogo no
banco descola da realidade e o **dashboard passa a mentir para a recepção** — oferece um
professor que saiu, ou esconde um que entrou. Este ADR decide o **componente de ingestão
contínua** que mantém `resources` fiel à fonte.

---

## 2. Decisões

### 2.1 Ingestão por ADAPTER, selecionado pelo `resource_source_binding`

O **core** do sincronizador é **genérico**: recebe `tenant_id` + `binding` e orquestra
upsert/soft-delete/cadência. **Cada fonte é um adapter** (uma implementação), escolhido pelo
`kind` do `resource_source_binding` (ADR-025):

- **`SCRAPE_EXTRANET`** (unidades ADR, **momento 0**): lê a Extranet via **scraping sob
  throttle**. É o caminho de **Valinhos**.
- **`NATIVE`** (outras empresas): **não há sincronização externa** — o **configurador do
  Regente** escreve direto no schema `resources`. O sincronizador **não roda**; a fonte da
  verdade é o **próprio Regente** (toggle de proveniência DESLIGADO, ADR-025 DP-D).
- **`API`** (**momento 1**, quando a franquia entregar a spec): adapter **bidirecional**
  substitui o scraping **sem mudar o core** do sincronizador.

> O core não conhece Extranet nem API — só o contrato do adapter. Trocar a fonte = trocar o
> adapter; o resto do sistema (motor de interseção, dashboards) não muda.

### 2.2 Contrato de UPSERT (idempotente, por identidade estável)

- **Identidade do recurso na fonte = `external_ref`** (id do professor em
  `update.php?id=N`; `id_sala`). **É exatamente por isso** que `external_ref` + o **UNIQUE
  parcial** entraram na 046.
- A cada execução, o sincronizador **compara a fonte com o estado no banco** e aplica:
  - **INSERT** — recurso novo na fonte;
  - **UPDATE** — recurso existente cujos dados mudaram;
  - **SOFT-DELETE** — recurso que sumiu da fonte (ver §2.3).
- **Idempotente:** rodar duas vezes **não cria lixo nem duplica** (a identidade estável
  `external_ref` casa a linha existente; o UNIQUE parcial impede duplicata).

### 2.3 SOFT-DELETE (preserva histórico)

- Recurso que **some da fonte** → `active = false` (**NÃO deleta**). Sua disponibilidade
  **sai da busca**: recurso inativo **não aparece em encaixe** e suas linhas de grade **não
  contam como vigentes**.
- **Reaparece** na fonte → **reativa pelo MESMO `external_ref`** (`active = true`). O
  **histórico nunca se perde** (vínculos e disponibilidade antigos continuam, apenas
  inertes enquanto inativo).

> Espelha o que a própria Extranet faz: professor desligado vira `status = Inativo`, não some
> do cadastro. O soft-delete é a tradução canônica disso.

### 2.4 Cadência

- Sincronização **DIÁRIA automática**, em **horário de baixo movimento** (madrugada), sob o
  **mesmo throttle conservador** do scraping: **serial, gap entre requisições, para no 1º
  403/429** (cooldown).
- A cadência é **config por tenant** (no `resource_source_binding`), **não constante global**.
- **Justificativa:** recurso muda **devagar** (dias/semanas); a Extranet é **frágil e pune
  rajada** ([[extranet-rate-limit-allowlist]]); diária **pega toda mudança antes de a
  recepção abrir**.
- No **momento 1/API**, a ingestão pode virar **event-driven** e a cadência perde relevância.

### 2.5 Cifragem de credencial

- As credenciais da fonte (Extranet) ficam **cifradas em `resource_source_binding.config`**.
- A **CHAVE de cifragem mora em variável de ambiente do container** — **NUNCA** hardcoded,
  **NUNCA** no banco, **NUNCA** no `.env` commitado.
- **Reusa o mecanismo existente**: **`src/crypto.js`** (AES-256-GCM, chave derivada de
  **`LM_ENCRYPTION_KEY`**; layout `base64(iv[12] | tag[16] | ciphertext)`), o **mesmo** já
  usado para `meta_page_token_enc` e `evolution_token_enc`. Nada novo a inventar.

### 2.6 Fronteira multi-tenant (anti-vazamento)

**Tudo específico da Extranet é conhecimento do ADAPTER de Valinhos**, confinado **atrás do
binding `SCRAPE_EXTRANET`**. **NÃO vaza** para o core do sincronizador nem para o schema:

- ids de curso; nomes de endpoint (`buscar_lista.php`, `update.php`,
  `disponibilidade_salas_lista.php`, `monta_lista.php`);
- forma do HTML;
- o **de-para 33 disciplinas → 22 capabilities**;
- o **mapa de status `Ativo`/`Inativo`**.

**O que cruza a fronteira é só o resultado genérico:** `resources`, `capabilities`, vínculos
(`resource_capability`), disponibilidade (`resource_availability`). O **de-para 33→22** e o
**mapa de status** ficam **documentados aqui como config do adapter Valinhos** (seed config
#1) — Apêndice A.

### 2.7 Relação com o ADR-008 (não-duplicação)

- O sincronizador escreve o **CATÁLOGO** (recorrente) e, quando a fatia datada existir, a
  **OCUPAÇÃO M0** (projeção `occupation_snapshot`).
- **NÃO é o motor de agendamento**: não escreve `service_booking` nem valida colisão.
- É **ingestão `read-from-source → write-to-resources`**, distinta do **validador write-time**
  do ADR-008. Os dois nunca se sobrepõem (ADR-025 §E.3).

---

## 3. Escopo da primeira entrega (faseamento)

- **1ª execução do sincronizador = a rodada inaugural** que popula a fatia recorrente de
  **Valinhos**: **24 professores ativos**, **9 salas** (sem vínculo de disciplina),
  **22 capabilities** no catálogo (**10 instanciadas**), **72 vínculos** professor↔capability,
  **136 linhas** de disponibilidade. É o que antes chamávamos de **"seed"** — agora é a
  **rodada inaugural do sincronizador**, não um script à parte.
- **Vínculo `sala↔capability` NÃO entra por aqui:** a Extranet **não tem esse cadastro** (o
  `config_salas/update.php` só guarda nº/descrição/status). Será **atribuído por humano**
  (fluxo "Regente sugere, recepção atribui") — **ADR/feature separada**.
- **Formato do vínculo** (`dupla`/`grupo`/`individual`) fica **fora** até haver consumidor
  (047 / coluna JSONB no `resource_capability`).

---

## 4. Pendências (abertas)

1. **Mecanismo de agendamento diário** — cron do container? job runner? a decidir na
   implementação.
2. **Tela "sincronizar agora" (manual)** — **fora de escopo agora**; só a diária automática.
3. **Detecção de mudança de grade** — **full re-scrape diário** vs. **diff incremental** — a
   decidir na implementação (o re-scrape diário sob throttle é o default seguro).

---

## 5. Consequências

- **Positivas:** o catálogo deixa de envelhecer; reativação/desligamento na fonte se reflete
  sozinho; o soft-delete preserva histórico sem sujar a busca; a fronteira do adapter mantém o
  core/schema limpos de qualquer especificidade da Extranet, viabilizando outros tenants e a
  futura troca scraping→API sem retrabalho.
- **Custos / riscos:** scraping diário depende da forma do HTML da Extranet (frágil); o
  throttle torna a sincronização **lenta de propósito** (aceitável: recurso muda devagar e a
  rodada é noturna); a chave `LM_ENCRYPTION_KEY` vira dependência operacional crítica (perdê-la
  = ciphertexts ilegíveis).

---

## Apêndice A — Config do adapter Valinhos (seed config #1)

> Documentação do conhecimento confinado ao adapter `SCRAPE_EXTRANET` de Valinhos. **Não é
> schema nem core** — vive na configuração/código do adapter.

**Endpoints (sob sessão autenticada + throttle):**
- Professores (competência autoritativa): `mod_professores/update.php?id=N` (checkboxes
  `cursos[]`; status `<select name="status">` = `Ativo`/`Inativo`).
- Professores (lista de ids): `mod_professores/monta_lista.php`.
- Professores (grade/disponibilidade recorrente): `mod_professores/buscar_lista.php?curso=X&...`.
- Salas (lista + grade): `config_salas/monta_lista.php`, `rel_cont_mat/disponibilidade_salas_lista.php?id_sala=X`.

**Mapa de status:** `Ativo` → `active=true`; `Inativo` → `active=false` (soft-delete §2.3).

**De-para 33 disciplinas → 22 capabilities** (formato colapsa na base; vira atributo do
vínculo, fora de escopo até §3):

| capability | ← disciplinas (id) | capability | ← disciplinas (id) |
|---|---|---|---|
| Guitarra | 12, 40(dupla) | Musicalização | 24(grupo), 27(indiv.) |
| Baixo | 13 | Musicoterapia | 44 |
| Violão | 14, 28(dupla), 36(grupo) | Violino | 50 |
| Canto | 15, 32(dupla) | Saxofone | 51 |
| Piano | 16(split), 34 | Violoncelo | 45 |
| Teclado | 16(split), 35, 38(dupla) | Teoria Musical | 18 |
| Bateria | 17, 39(dupla) | Improvisação | 23 |
| Harmônica | 21, 41(dupla) | Gravação | 22 |
| Ukulele | 33 | Home Studio | 19 |
| Prática em Conjunto | 20 | Produção | 47(indiv.), 48(turma) |
| Inicialização Musical | 46 | JAM | 42, 43 |

Notas: **`16 Piano e Teclado` → DOIS vínculos** (Piano + Teclado). **JAM 42/43** têm nome
idêntico na fonte (colapsados em "JAM"). **Banda/Projeto de Banda** não existe como disciplina
(só o relatório `rel_professores/projeto_bandas.php`); a mais próxima é **Prática em Conjunto**.
