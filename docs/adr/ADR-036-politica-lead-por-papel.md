# ADR-036 — Política de lead por papel do contato
Status: Aprovado · Camada 1 no ar · read-only do E1.3 incorporado (corte E1.3a papéis / E1.3b vínculo) · perguntas de resgate por papel definidas | Data: 2026-07-07 Número: ADR-036 (provisório — confirmar a próxima casa livre no índice do repo) Supersede em parte: ADR-003 (classificação/triagem — known_contacts/Portão 0), ADR-018 (internal_contacts), ADR-029 (gate de supressão) Efeito nos ADRs superados: os corpos de 003/018/029 são preservados como histórico; cada um recebe apenas um cabeçalho "superado em parte por ADR-036". Não reescrever os ADRs antigos. Depende de: ADR-037 (cadastro-mestre de pessoas) — a partir de 2026-07-07, o cadastro de pessoas/contatos/papéis/contas vira fundação compartilhada (comunicação + CRM também consomem). Migram pro 037: E1.9 (unidade de contato), E1.10 (provedor plugável) e E1.3a/b (população). Este ADR fica só com a lógica de decisão (papel→política, perguntas de resgate, supressão/criação, E1.11). O 037.1 é o antigo E1.3a re-enquadrado. Nota de numeração: as decisões abaixo mantêm os códigos E1.x da versão-emenda por continuidade (Leo e o Code já referenciam E1.3, E1.7, E1.9).
________________________________________
Gatilho
Conversa recepção↔professor Giovanni Moura classificada como lead. O diagnóstico read-only (2026-07-07) revelou o mecanismo real e desfez a hipótese inicial (que era known_contacts/kind faltando).
Estado real hoje (read-only)
•    known_contacts (ADR-003) existe mas está vazia e não é lida — desenho morto.
•    Gate de supressão vivo: internal_contacts (ADR-018) — igualdade exata de dígitos, type não influi, descarta e dá return.
•    Gate de papel: contact_role_member (ADR-029 f3) vazio e mode='off' — inerte. Mas a máquina de shadow dele (gate_shadow_log, modo Observando, alarme hard+lead, janela 7 dias) está pronta e rodando agora para Valinhos.
•    Tratamento de professor: _isRelationshipContact lê app.professor_notificacao (tabela do Scheduler) com igualdade exata → lead 5519994301015 ≠ cadastro 19994301015 → 21 de 22 professores vazam.
•    Classificador: só conteúdo. Prompt crava "a intenção decide, nunca a identidade".
Tese da emenda
Identidade não é um portão que cala, nem entra no prompt do classificador. O papel do contato escolhe qual pergunta o classificador faz ao conteúdo. Default descarta; o classificador só resgata para lead com um sinal estreito. A estrutura é do core; os papéis e as perguntas são config por vertical/tenant.
Pipeline revisado
mensagem
   │
 Gate 0: resolve papel (contato conhecido → papel; senão desconhecido)
   │
   ├─ desconhecido ───────────────► classificador normal (como hoje)
   │
   └─ conhecido → aplica POLÍTICA DO PAPEL:
             default = descarta (operacional)
             pergunta de resgate → classificador lê o conteúdo com ela
                │
        sinal ausente  → DESCARTADO      (log de supressão — ADR-029)
        sinal presente → LEAD / OPORTUNIDADE (log de criação — novo)
________________________________________
Decisões
Camada 1 — conserto imediato (independe de shadow)
#    Decisão
E1.1    _isRelationshipContact passa a usar match BR-aware (telBR.matchKeys), como os outros lookups do mesmo arquivo. Verificado: matchKeys real reconhece 22/22 dos professores vazados (formato era o único defeito; números sem 9º dígito sobrevivem ao round-trip). É preventivo: os 22 registros atuais já foram varridos pra NOT_LEAD por um SERVICE; a Camada 1 não conserta o passado, impede a reincidência — "reduz a fila" é só pra frente.
Consolidação de identidade
#    Decisão    Substitui
E1.2    Uma fonte única de "contato com papel, por tenant". Popular contact_role_member (sempre esteve vazio), o gate passa a lê-lo, e aposentar _isRelationshipContact. Colapsa 3 mecanismos paralelos em 1.    internal_contacts + contact_role_member + _isRelationshipContact dispersos
E1.3    Anti-leakage, corrigido: a fonte de professores/alunos é compartilhada entre Scheduler e LM — mesmo dado de negócio, mesma plataforma. O que a regra proíbe é o core depender do formato/origem de um tenant (nome/estrutura de professor_notificacao é artefato do adapter). Os dois apps leem de um contrato neutro de plataforma; o adapter da Valinhos o alimenta. Compartilhado sim; amarrado ao formato de um tenant, não.    leitura direta de app.professor_notificacao pelo LM
Máquina de política por papel (config-as-data)
#    Decisão
E1.4    O core ganha a estrutura genérica papel → política, política = { default: descarta|vigia, pergunta_de_resgate }. O Gate 0 identifica o papel e injeta a pergunta certa no julgamento do conteúdo. Nada de "professor"/"aluno" no código do core.
E1.5    Três camadas de config (não hardcode disperso): (a) core = a máquina papel→política, universal; (b) template de vertical = papéis e perguntas padrão da vertical — ex. "escolas" traz professor/aluno, servindo escola de música e escolas em geral; (c) instância de tenant (Valinhos) = binding da fonte de identidade e overrides. Esclarecimento (gap do Code): por ora o template de vertical não é tabela — é um seed que escreve as linhas de role_lead_policy do tenant. Uma tabela real de vertical da qual o tenant herda é dívida registrada, a ser criada quando chegar o segundo tenant da mesma vertical (padrão config-as-data: alinhar na chegada do 2º tenant). Professor/aluno são conceito de vertical, não do sistema nem de um único tenant.
E1.9    Unidade de contato (regra transversal do core). Uma conta tem um titular do serviço (quem consome) e um ou mais responsáveis pela conta (quem responde por ela). Eles coincidem no caso comum (adulto que se matricula e paga sozinho), mas podem divergir — filho maior com contrato no nome do pai, empresa que paga o funcionário, parente que administra a conta, menor com responsável. A unidade de contato são todos esses telefones; a política do papel vale para todos; o resgate (indicação/expansão) atribui à conta, não ao telefone que falou. Isso vive no core, dirigido por um dado explícito de vínculo na fonte (titular/responsável da matrícula/contrato). Menoridade é apenas um dos gatilhos que garante a busca por responsável — a maioridade não encerra a busca, só não a força. Sinal de menoridade ausente na fonte → fallback conservador (assume que pode haver responsável / pergunta à recepção), nunca assume adulto-sozinho e perde o vínculo.
Políticas da vertical "escolas"
Papel    Default    Resgate →
Professor    descarta (operacional)    vira lead só com intenção explícita de matrícula. Começa em estreito (si/família) e ganha amplo (+amigo/conhecido) via shadow — não o contrário. Motivo (caso Noah): um professor agendando experimental de um prospecto da escola é, no conteúdo, indistinguível de um professor indicando um conhecido. É exatamente em amplo que a separação "funcionário fazendo o trabalho" vs "pessoa indicando amigo" colapsa. amplo é config do papel (rescue_scope), liberado só quando o shadow provar que dá pra separar. Vale a mesma lógica para outras verticais.
Aluno (conta = aluno + responsáveis)    descarta (operacional)    Instância da regra de unidade de contato (E1.9): a conta é o aluno (titular) + seus responsáveis pela conta. Todos os telefones da unidade recebem a política de aluno. expansão = o próprio aluno já matriculado querendo mais serviço (outra modalidade, aula extra) — mesma pessoa, nenhum aluno novo → oportunidade na conta. qualquer pessoa-aluno nova (outro filho, sobrinho, amigo, a própria mãe se quiser se matricular) → lead novo, um por pessoa. A conta/responsável não reclassifica o lead — só enriquece a proveniência (indicado_por + vínculo de conta).
Perguntas de resgate por papel (professor e aluno erram por motivos opostos)
A pergunta_de_resgate é desenhada por papel — o eixo difícil de cada um é diferente, então herdar uma pergunta genérica erra. Cada uma é um critério fechado avaliado pelo Gemini com o papel como contexto, devolvendo {resgata, confidence, motivo} (não texto livre).
Papel    Eixo primário (sinal forte)    Ordem da pergunta
Professor    função vs negócio novo    1) É fluxo operacional dele? (aula/aluno dele, agenda, reposição, confirmação vinda da recepção) → descarta. 2) Não sendo operacional, há intenção de matrícula? → resgate; rescue_scope (estreito/amplo) só refina quão longe conta, já sem o ruído operacional. O discriminante forte é a natureza da mensagem, não o grau de parentesco.
Aluno    pessoa-aluno nova vs mesmo aluno    1) É operacional da conta? (falta, remarcação, pagamento, aluno dele/dela) → descarta. 2) Surge uma pessoa-aluno nova? → lead novo (proveniência: quem trouxe + conta). 3) É o próprio aluno querendo mais serviço? → expansão na conta. "Tem gente nova aqui?" é sinal concreto — some o eixo ambíguo "dentro/fora da conta".
Regra que fecha o caso do outro filho: o lead é sobre a pessoa-aluno. Aluno novo = lead novo, sempre, mesmo que a conta/contrato já exista (Leo, 2026-07-07). "Colocar meu outro filho" = lead novo com indicado_por=responsável + vínculo à conta existente — o que de brinde marca leads que chegam por família já cliente (convertem mais), sem inflar a contagem.
Lead ≠ contato
#    Decisão
E1.6    Criar lead/oportunidade a partir de uma conversa sem que o alvo seja o dono do número. Campos origem (proprio|expansao|indicacao) e indicado_por. Chave de dedup (gap apontado pelo Code): o lead de indicação nasce sem telefone (o número é do aluno, não do indicado). Regra explícita: se o aluno passou o contato, esse telefone é a chave e o dedup é confiável; se passou só o nome, não há auto-merge — quando alguém novo escrever, o sistema sugere o vínculo à recepção (candidato: "é a pessoa que Fulano indicou?") e um humano confirma. Nunca auto-merge por nome. É o caminho mais frágil — por isso último e com shadow próprio.
Reconciliação com ADR-029 — duas metades, duas janelas
#    Decisão
E1.7    A metade de supressão (professor→descarta; aluno-default→descarta) estende o gate do ADR-029 (mesmo gate_shadow_log, modo Observando, alarme hard+lead, mesmo critério). Correção (revisão do Code): ela NÃO herda a janela que está fechando agora. As 386 linhas em observação são todas presignal (histórico); hard (papel) é zero porque só dispara via _lookupRole lendo contact_role_member, que está vazio. Logo hard+lead=0 hoje = "nunca medido", não "medido e limpo". A supressão de professor ganha janela própria de 7 dias que só começa quando os papéis forem populados (E1.3). Caminho crítico: E1.3 (contrato neutro alimenta papéis) → hard começa a aparecer no log → aí o relógio de 7 dias passa a valer. A janela presignal que fecha agora é decisão à parte do ADR-029, não desta emenda.
E1.8    A metade de criação (indicação→lead; expansão→oportunidade) não cabe no gate de supressão: schema e alarme são de "suprimir", e o risco é invertido ("criei um falso", não "suprimi um verdadeiro"). Ganha log e alarme próprios (falso-positivo de criação) e janela própria (zero dado hoje). As duas metades não sobem no mesmo clique.
Dois trilhos no mesmo motor de shadow (não um substitui o outro): o gate do ADR-029 tem duas fontes de sinal. O trilho presignal (histórico) é o objetivo original — está rodando, maduro, permanece 100% válido e pode ser promovido por conta própria, independente desta emenda; sua janela está fechando de verdade. O trilho hard/por papel (professor e aluno) é o que esta emenda acrescenta e ainda não começou (papéis vazios). A emenda soma o segundo ao lado do primeiro; não abandona nem invalida nada do que já foi observado.
Fonte de vínculo plugável e medição automática
#    Decisão
E1.10    Fonte de vínculo é um provedor plugável por tenant. O LM consome sempre o contrato neutro account_member; nunca sabe de onde veio. Quem preenche é um provedor de vínculo, trocável sem tocar o LM: hoje (Valinhos) lê a Extranet (mod_alunos/list_resp.php); amanhã, a API da Extranet; multi-tenant, a gestão de contratos do próprio Regente. account_member já nasce com coluna source (extranet | conversa | api_extranet | contratos_regente) pra rastrear proveniência e permitir um provedor futuro substituir só os vínculos que passa a dominar. A leitura fica atrás de uma interface de provedor (getAccountMembership(tenant,…)), não de um SELECT cravado. Custo hoje: uma coluna + uma função em vez de query solta — evita reconstruir quando a API chegar.
E1.11    Medição autoarmada e autopromovida (Leo não é o cron). Início: o relógio de shadow de um papel arma sozinho na primeira observação hard daquele papel no gate_shadow_log — nasce do dado, não de comando. Fim: quando batem as duas condições — 7 dias corridos desde a 1ª observação E hard+lead=0 no período — o sistema se promove sozinho Observando→Ligado, por papel. Trava: se o alarme não zerou (mediu e sujou), não liga sozinho — escala pra humano, porque desligar cliente real é irreversível. Automático pra ligar no caminho limpo; humano só no caminho sujo. Confirmado no read-only: gate_shadow_log.role_id (FK à definição de papel) permite derivar a 1ª observação por papel via MIN(created_at) WHERE would_action='hard' — sem coluna nova; um marcador explícito de "relógio armado em" é aditivo opcional.
Achados do read-only (2026-07-07) e o corte E1.3a / E1.3b
O read-only confirmou os dados reais e reordena o E1.3:
Fonte    Telefone?    Vínculo resp↔aluno?    Nota
Extranet list_resp (export)    Sim, fone_celular (185 resp., 96%), sem-55    Não — nenhum id de aluno na tela/export do responsável    matchKeys cobre o formato
Extranet ficha do aluno (update_alunos.php)    fone do aluno    Sim, por id (tpresp 0=próprio / 1=outro aluno via id_aluno_resp / 2=id_responsavel) + familiares[]    vínculo só obtível varrendo as ~371 fichas por-id
app.professor_notificacao    Sim (42/42), sem-55    (papel professor, sem responsável)    populável limpo
Local adr_scheduler    Não (só nomes)    Não    o telefone do aluno-titular NÃO está local — só na Extranet
Correções ao ADR: (1) o telefone do aluno-titular não vem de sync local — vem do export da Extranet, como o do responsável; a suposição anterior de "fonte local mais completa" estava errada. (2) O vínculo é estruturado (id_responsavel), mas mora na ficha do aluno, não na tela de responsável — montar account_member exige varredura por-aluno.
O corte que isso força — e que de-risca tudo:
#    Decisão
E1.3a    Papéis por telefone (barato, inicia o relógio). Popular contact_role_member com o papel de cada telefone: professor (professor_notificacao), responsável (list_resp export), aluno-titular (alunos_export). Tudo por telefone, matchKeys, sem-55. A supressão só precisa disto — o gate hard decide "descarta?" sabendo só o papel, não a conta. Logo E1.3a sozinho arma os relógios de professor e aluno. É o próximo passo implementável.
E1.3b    Vínculo account_member (caro, só criação, adiado). Exige a varredura por-aluno (~371 fetches × throttle 25s ≈ 2–3h de janela) pra ler tpresp/id_responsavel/familiares[]. Só a metade de criação precisa disto (expansão na conta, lead novo com indicado_por+conta). Como criação já era último/shadow-próprio (E1.8), o vínculo caro fica naturalmente depois — não bloqueia a supressão.
PII (achado do read-only, registrar): update_resp.php serve senha em texto e o export expõe CPF/endereço. O provedor de vínculo (E1.3b) lê só telefone + vínculo, descarta o resto, e nunca persiste senha/CPF/endereço. A senha em claro na Extranet é problema dela (fora do nosso escopo), mas fica anotado.
Cobertura ainda não medida: as duas fontes de telefone chegam sem-55 → matchKeys resolve o formato, mas se o número cadastrado é o número que a pessoa usa no WhatsApp continua não-medido. É a pré-condição do descarte silencioso (E1.11 / rollout), a medir pelo lado inbound.
Adapter intocado (invariante): o adapter de scraping da Valinhos funciona e não se mexe. O LM lê as fontes que já existem (professor via professor_notificacao; responsável via list_resp.php; aluno-titular via o sync no Postgres) e constrói dentro de si o que é novo (contact_role_member, account_member, vínculos). A tradução Extranet→neutro vive no provedor do LM, não no adapter. Leitura de endpoint novo, se necessária, é aditiva (não altera fluxo de scraping existente) e respeita throttle ≥25s + advisory lock.
________________________________________
Schema (aditivo)
-- CONTA e seus membros (regra de unidade de contato, E1.9) — genérico, no core
service_account( tenant_id uuid, account_id uuid, ... )        -- a conta/pessoa servida
account_member(
  tenant_id  uuid,
  account_id uuid,          -- a conta a que este contato pertence
  phone      text,          -- E.164
  bond       text           -- 'titular' (consome) | 'responsavel' (responde pela conta)
)   -- vínculo explícito da fonte (matrícula/contrato); menoridade só GARANTE buscar responsável

-- fonte única de papel: contact_role_member (ADR-029) passa a ser LIDA e POPULADA
--   telefone → papel → account_id (o elo que faltava: a qual conta este contato pertence)
--   papéis por tenant, alimentados pelo adapter (contrato neutro), nunca do core

-- política por papel (config-as-data, por vertical/tenant)
role_lead_policy(
  tenant_id      uuid,   -- RLS
  role           text,   -- 'professor','aluno',... (definido pela vertical)
  default_action text,   -- 'descarta' | 'vigia'
  rescue_prompt  text,   -- pergunta que o classificador faz ao conteúdo
  rescue_scope   text    -- 'estreito' (si/família, DEFAULT) | 'amplo' (+amigo/conhecido, só após shadow)
)

-- lead/oportunidade desacoplado do contato
ALTER TABLE leads
  ADD COLUMN origem       text,   -- proprio | expansao | indicacao (amplia domínio existente)
  ADD COLUMN indicado_por text,   -- ref do contato que originou o lead (nullable)
  ADD COLUMN account_id   uuid;   -- conta-alvo da oportunidade/expansão (indicação/expansão penduram na conta, não no telefone)

-- log de criação (espelha gate_shadow_log; alarme invertido = falso-positivo de criação)
lead_creation_shadow_log( tenant_id, phone, role, would_create, kind, reason, created_at )
Rollout / condição de ativação
•    Camada 1 (bug do telefone): sobe já. Subtração, não depende de shadow.
•    Supressão por papel (professor E aluno): caminho crítico = E1.3 primeiro. Só depois que contact_role_member for populado (professor + aluno/responsáveis) é que o hard desses papéis aparece no gate_shadow_log. Aí começa a janela própria de 7 dias; promove Observando→Ligado com 7 dias de observação REAL do papel E alarme hard+lead=0. Aluno tende a liberar primeiro (fonte mais confiável). Não confundir com a janela presignal que fecha agora (aquela não tem uma única observação por papel).
•    Criação (indicação/expansão): shadow próprio, janela própria. Indicação primeiro (mais limpa — lead novo pelo fluxo normal); expansão depois (introduz o objeto "oportunidade"). Precisão sobre recall para todo contato conhecido.
•    Confiança do cadastro — pré-condição do descarte silencioso. O match BR-aware resolve formato, não identidade: o número guardado só serve de base de descarte se for o número que a pessoa de fato usa no WhatsApp. Cuidado com o viés de sobrevivência (Code): os 22 vazados só provam que professores que já estavam no cadastro são recuperados — não dizem nada sobre o professor perigoso, o que conversa de um número que não está no professor_notificacao (nenhum match, BR-aware ou não, jamais o vê). Então a medição que de fato libera o descarte é a direção (a), medida pelo lado inbound: dos números que de fato conversam e são de professor, quantos batem no cadastro (miss rate real). A direção (b) — dos que batem, algum traz conteúdo de prospecto (número reaproveitado) — é o alarme complementar. Cobertura inbound alta + alarme zero → cadastro confiável. Senão, enriquecer com o número que de fato conversa (o WhatsApp é a verdade mais confiável) antes de confiar. Na Camada 1 isso é inócuo (professor só vai pra revisão); a medição é o gate da Camada 2.
•    Ritos padrão: kill-switch/flag por tenant, migrações aditivas, backup de schema em /root/lm-backups/ antes de migrar.
Invariantes preservadas
•    Config-as-data: máquina genérica no core; papéis e perguntas por vertical/tenant.
•    Anti-leakage (corrigido): fonte compartilhada via contrato neutro; formato/origem de um tenant só no adapter.
•    Human-in-the-loop: criação de lead/oportunidade entra na fila de aprovação.
•    Medição sem depender de staff marcar status: tudo deriva de eventos reais; toda métrica de velocidade emparelhada com o alarme de qualidade.
Estratégia de reversão (invariante — espelha ADR-035 Emenda 1)
Toda mudança desta emenda nasce com caminho de volta. Quatro camadas, aplicadas conforme o tipo de mudança:
#    Camada    Regra
1    Kill-switch / flag por tenant    Comportamento novo nasce atrás de flag. Problema em produção → desliga a flag → volta ao comportamento de hoje em segundos, sem deploy. Primeira rede pra toda mudança de comportamento (sobretudo o descarte).
2    Shadow antes de produção    A lógica nova roda em paralelo, loga o que faria, não age. O melhor caminho de volta é o problema aparecer no log, não em produção.
3    Migrações só aditivas    Colunas/tabelas novas adicionam; nunca apagam nem renomeiam. O formato antigo fica intacto ao lado do novo — desligar a flag faz o código antigo reencontrar seus dados onde sempre estiveram. É o que torna o rollback de dados possível.
4    Backup de schema antes de migrar    /root/lm-backups/ antes de qualquer migração. Rede de baixo, pro caso extremo.
Ordem de reversão (leve → pesado): desliga a flag → (se preciso) git revert do código → (só em caso extremo, banco inconsistente) restaura o backup. Como tudo é aditivo, restaurar banco quase nunca é necessário.
Mapa por mudança:
Mudança    Escreve no banco?    Como voltar
Camada 1 — match de telefone    Não (só código)    git revert + rebuild (segundos). Não há estado pra desfazer. Match errado só manda pra revisão — recuperável por humano.
Camada 2 — supressão (professor descarta)    Não (lê config/papel)    Flag off → volta ao comportamento de revisão de hoje. Usa a máquina de shadow do ADR-029, mas com janela própria que só inicia após E1.3 popular os papéis.
Camada 2 — criação (indicação/expansão)    Sim, aditivo (colunas + log)    Flag off → colunas novas ficam sem uso. Backup antes de migrar.
Condição de ativação: nenhuma parte que descarta ou cria em produção antes de (a) passar por shadow com divergências compreendidas e (b) estar atrás de flag desligável. Ativação por tenant, gradual.
Decisões confirmadas (2026-07-07)
•    Promovido a ADR próprio (ADR-036, número a confirmar no índice do repo), com ADR-003/018/029 marcados "superados em parte" — em vez de emenda enterrada no log do 003.
•    Professor começa em estreito (si/família); o shadow libera amplo (+amigo/conhecido) só depois de provar que separa "funcionário fazendo o trabalho" de "indicação de amigo" (caso Noah). Reverte o amplo-com-fallback que havia sido cogitado.
Próximo passo de implementação
Camada 1 (E1.1) no ar (commit 9b9c78b). O próximo implementável é o E1.3a — popular contact_role_member com os papéis por telefone (professor + responsável + aluno-titular, via matchKeys), que é o que arma os relógios de shadow de professor e aluno. E1.3b (vínculo account_member via varredura por-aluno) e a Camada 2-criação ficam depois, pois só a criação precisa do vínculo. O internal_contacts (Camada 1-bis) pega carona no E1.3a, quando já se estará mexendo em contatos.
Pendências registradas
•    Camada 1-bis — internal_contacts BR-aware (baixa urgência). O gate de descarte duro de internal_contacts (engine.js:997-1004) usa a mesma igualdade exata de dígitos que o _isRelationshipContact tinha — mesmo bug de formato (55 / 9º dígito). Confirmado pelo Code: das 6 linhas, várias já casariam por acaso do cadastro, mas ao menos 1 (Rafaela, 5519997078916) depende da sorte. Direção do risco é branda: quando falha, um membro da equipe vira lead (barulho no funil, recuperável na fila) — não é descarte silencioso engolindo cliente real. Conserto = mesmo padrão matchKeys → = ANY(...). Não juntar ao deploy atual (manter o commit da Camada 1 atômico/reversível); fazer junto do E1.3, quando a consolidação de contatos já estiver sendo mexida.
