# Guia — Meta App Review para envio IG DM + Messenger (ADR-042 / E16)

**Data:** 2026-07-28 | **Dono da execução:** Leo | **Refs:** [SPIKE-E16](adr/SPIKE-E16-envio-meta.md), [ADR-007](adr/ADR-007-multicanal.md)

> **⚠️ Correção de escopo (2026-07-28, esclarecido por Leo):** este review **NÃO é
> necessário para a ADR Valinhos.** O envio IG/Messenger das contas da **própria Valinhos**
> é "só ligar" — o app opera sobre assets próprios (com role no app), então usa as
> permissões sem App Review. O sender já existe no código.
>
> **Quando este guia passa a valer:** quando o **1º tenant EXTERNO** (outra unidade ou
> empresa) conectar as **próprias** contas Meta via o **dashboard self-service (E16-05)**.
> Aí o app passa a ser usado por negócios sem role nele → a Meta exige **App Review +
> Advanced Access + Live mode** (e provavelmente Business Verification). É o gate da **Fase
> 2 do roadmap (1º cliente externo)** — deve ser aberto **em paralelo, antes** desse cliente
> entrar, porque a aprovação leva semanas. Não é bloqueio de agora.
>
> **Modelo de operação (decisão de Leo):** cada tenant configura as próprias contas no
> dashboard dele; **sem administração central** pelo super-admin do Regente.

> **O que eu (Claude) NÃO faço por você** e por quê: login na conta Meta, aceite de termos,
> verificação de negócio e submissão do review envolvem credenciais e consentimento legal
> em nome da empresa — por política, esses passos são seus. Eu preparo todo o material de
> apoio (textos de caso de uso, roteiro do screencast, checklist) e reviso o que você montar.

---

## Visão geral do caminho crítico

```
1. Business Verification (Meta Business Suite)        ← mais demorado, começar por aqui
2. App no modo certo + produtos adicionados
3. Advanced Access das permissões (App Review)        ← depende de 1 e 2
4. Feature "Human Agent" (janela de 7 dias)
5. Inscrever webhook em `messages`/`messaging_postbacks`  ← [CORE] no código, não no painel
```

## O que precisamos de permissão (Advanced Access)

| Canal | Permissão | Para quê |
|---|---|---|
| Instagram | `instagram_business_manage_messages` | enviar/receber DM em nome da conta IG do cliente |
| Messenger | `pages_messaging` | enviar/receber mensagens da Página FB do cliente |
| Ambos | **Human Agent feature** | estende a janela de resposta de 24h → **7 dias**, para atendimento **humano** (bot proibido nessa janela estendida) |

> A feature Human Agent **casa com o guardrail do LM** (envio sob supervisão da recepção —
> `no-auto-send-until-receptionists-onboarded`). É argumento a favor na submissão.

## Regras de envio que o review vai cobrar (e que o código precisa respeitar)

- **Janela de 24h:** dentro dela, envio livre (inclusive conteúdo promocional). Fora dela,
  mensagem padrão é **bloqueada** — só com `HUMAN_AGENT` tag (7 dias, humano) ou template
  de Marketing/Utility aprovado.
- Tags promocionais antigas fora da janela migraram para **Marketing Messages / Utility
  Templates**. As tags `CONFIRMED_EVENT_UPDATE`/`ACCOUNT_UPDATE`/`POST_PURCHASE_UPDATE`
  passaram a dar **erro 100 desde 27/04/2026** — não usar.

---

## Passo a passo (você executa; eu apoio cada item)

### 1. Business Verification — comece hoje
- [ ] Meta Business Suite → **Configurações do negócio → Central de Segurança →
      Verificação do negócio**.
- [ ] Ter em mãos: CNPJ, comprovante de endereço da empresa, e um meio de contato
      (telefone/e-mail no domínio) que a Meta consiga validar.
- [ ] Submeter e acompanhar — este é o item que mais atrasa; o resto pode andar em paralelo.

### 2. App e produtos
- [ ] Confirmar o App existente no developers.facebook.com (o mesmo do onboarding de Lead
      Ads) ou criar um App de tipo **Business**.
- [ ] Adicionar os produtos **Messenger** e **Instagram** ao App.
- [ ] Conferir domínios, política de privacidade pública e URL de exclusão de dados (LGPD —
      já temos `/privacidade` e `/forget`; validar que estão públicos e apontados no App).

### 3. App Review — submissão das permissões
- [ ] Solicitar **Advanced Access** para `instagram_business_manage_messages` e
      `pages_messaging`.
- [ ] Descrição do caso de uso (eu redijo o texto — ver §"Material que eu preparo").
- [ ] **Screencast** demonstrando o fluxo real: cliente manda DM/mensagem → aparece no
      inbox do Regente → recepcionista humano responde. (Eu escrevo o roteiro; você grava
      quando a Fase 1/E16-02 tiver tela — ou gravamos com a rota atual `mensagem-meta`.)
- [ ] Justificar o modelo **multi-tenant** (gerenciamos Páginas/contas de terceiros com
      consentimento via nosso onboarding FLB) — ponto que a Meta revisa com rigor.

### 4. Human Agent
- [ ] Na submissão, marcar a necessidade da **feature Human Agent** e explicar que o envio
      é feito por **atendente humano** (recepção), não por bot — alinhado ao nosso guardrail.

### 5. Webhook (código — [CORE], não é painel)
- [ ] Inscrever os campos `messages` e `messaging_postbacks` no onboarding (hoje inscreve só
      `leadgen`). Isso é uma story de backend, rastreada no backlog.

---

## Material que eu preparo para você (é só pedir)
- Texto do **caso de uso** para cada permissão (IG e Messenger), no tom que a Meta espera.
- **Roteiro do screencast** passo a passo (o que mostrar, em que ordem, o que narrar).
- Checklist de **conformidade LGPD/privacidade** que a Meta valida (política pública,
  exclusão de dados, opt-in).
- Rascunho da justificativa **multi-tenant**.

## Dependências de código que andam em paralelo (não bloqueiam a submissão)
- [CORE] inscrever `messages`/`messaging_postbacks` no onboarding.
- [BRIDGE] fix da janela: parametrizar `messaging_type`/`tag` em `meta.sendMessage`
  (suporte `HUMAN_AGENT`) + erro legível quando a janela está fechada (`meta.js:69`).
- [CORE] corrigir vínculo leadgen↔WhatsApp (bug do Cenário B — já em sessão separada).

## Como acompanhar
Status de verificação e review ficam no painel do App (App Review → Permissions and
Features) e na Central de Segurança. Me avise quando cada etapa mudar de estado que eu
ajusto o gate de E16 no backlog.
