'use strict';
//
// tenant-demo.js — O QUE o tenant de demonstração do Lead Manager É. Decisão PURA, sem banco.
//
// POR QUE A DECISÃO MORA SEPARADA DA ESCRITA
//
// O script que grava (`deploy/seed-demo-mf8.js`) precisa de um PostgreSQL; este arquivo não.
// Então tudo que se pode errar sem o banco perceber — a flag que contém os efeitos externos, o
// estado da assinatura, o nome da assistente, o modo de envio da renovação — fica aqui e tem
// teste que roda em `npm test`, sem Docker, na máquina de quem estiver lendo.
//
// É o mesmo arranjo que o dashboard adotou em `lib/demo-seed.js`, e pela mesma razão: é o único
// jeito de uma afirmação sobre o tenant de demonstração ser CONFERIDA por quem não tem acesso a
// produção.
//
// ─── AS QUATRO COISAS QUE ESTE ARQUIVO EXISTE PARA NÃO DEIXAR ERRAR ──────────────────────────
//
//   1. `lead_manager_active` DESLIGADO. É o equivalente exato do `ativo = false` do dashboard, e
//      não por analogia: `lead_manager.tenants_active()` é literalmente
//      `SELECT id FROM tenants WHERE lead_manager_active` (migr 031), e TODO laço de fundo do LM
//      lê dela — renovacao-sweep, renovacao-auto-envio, boas-vindas-sweep, detectar-silenciosos,
//      reprocessar-pendentes, waSync.syncReconnections, plantao-noturno e dataRetention.
//      `routes/webhook.js:179` também recusa webhook de tenant inativo.
//      E as rotas que as telas usam — `/tenant/:id/inbox/*` e as leituras da tela de Renovações —
//      NÃO consultam esta coluna. Então: as telas abrem, e nada roda sozinho.
//      (verificado em código, 02/11/2026)
//
//   2. `is_demo` LIGADO (migr 187). Sem ele a gravação do cenário não acontece: ela resolve o
//      tenant por subconsulta que exige a flag. É o portão, e ele é SQL — ver o cabeçalho da 187.
//
//   3. NENHUMA CREDENCIAL. `zapi_token` e `evolution_token_enc` nulos, `evolution_instance` com
//      nome que se denuncia. Cada um é um gate de DADO a mais, por cima da trava de código:
//      `outbound.credsForTenant` não resolve remetente sem token, então nem um clique acidental
//      em "Enviar" alcança WhatsApp. ⚠ Gate de dado é proteção que SOME no dia em que alguém
//      preencher o campo "para a demo ficar mais completa" — e sem erro nenhum. Por isso ele é o
//      terceiro item, nunca o primeiro.
//
//   4. `renovacao_auto_envio` DESLIGADO, e `modo_comercial` em 'semi'. A tela de Renovações
//      MOSTRA o interruptor do envio automático (`rdb.getAutoEnvio`), e numa demonstração alguém
//      clica no que vê. Desligado, o toque de renovação é sempre rascunho que espera aprovação.
//      'semi' é o modo que a demonstração quer mostrar (a IA sugere, a recepção aprova) e é
//      inofensivo aqui: quem consome o modo é o autoReply, que só roda por webhook — bloqueado
//      pelo item 1.
//
// O QUE ESTE ARQUIVO NÃO DECIDE
//
// O `lead_tenant_id` em `app.franquia` (a chave que faz as telas do dashboard acharem este
// tenant) é do OUTRO repositório (adr-whatsapp-scheduler) e de outra sessão. Aqui só nasce o
// UUID; quem o grava lá é quem é dono daquele código. Ver docs/demo-mf8-lead-manager.md.
//

// ⚠ TRÊS CHAVES DE TENANT, QUE NÃO SÃO INTERCAMBIÁVEIS — a armadilha deste sistema:
//   • `app.franquia.bi_tenant_id`   → BI, Compasso e Regente Fiscal
//   • `app.franquia.lead_tenant_id` → Lead Manager (é o que este módulo cria)
//   • `app.franquia.slug`           → a URL (/f/clinica-exemplo/...)
// O modo de falha de chave errada neste projeto é ZERO LINHAS, não erro. Antes de concluir que
// algo "não existe" no LM, confira com QUAL chave a consulta foi feita.
const CHAVE_DO_LEAD_MANAGER = 'lead_tenant_id';

// O nome do tenant no LM. É o que aparece em `tenants.name` e em logs — e é a chave de
// idempotência do provisionamento (não há slug no schema lead_manager).
const NOME_DO_TENANT = 'Clínica Ortopédica Exemplo Ltda (DEMONSTRAÇÃO)';

/**
 * O tenant de demonstração do Lead Manager, como linhas a escrever. PURA.
 *
 * `slug` entra só para compor o nome da instância que se denuncia; ele NÃO é gravado no schema
 * lead_manager (que não tem coluna de slug) — é a chave da URL, do lado do dashboard.
 *
 * @param {{slug: string, nome?: string}} arg
 */
function tenantDeDemonstracao({ slug, nome = NOME_DO_TENANT }) {
  if (!slug) throw new Error('tenant-demo: slug é obrigatório (compõe o nome da instância).');
  if (!nome) throw new Error('tenant-demo: nome é obrigatório.');
  return {
    name: nome,
    is_demo: true,              // (2) o portão do seed
    lead_manager_active: false, // (1) fora de TODOS os laços de fundo, telas inteiras
    // (3) Nome de instância que NÃO parece uma instância: quem a procurar na Evolution lê, no
    // próprio nome, que ela não existe. A coluna é NOT NULL em produção, então algo tem de ir.
    evolution_instance: `demo-sem-whatsapp-${slug}`,
    evolution_token_enc: null,  // (3) sem token, `outbound.credsForTenant` não resolve remetente
    zapi_token: null,           // (3) sem token, o webhook do Z-API não autentica
  };
}

/**
 * A assinatura da feature LEAD_MANAGER. PURA.
 *
 * ACTIVE e com validade longa de propósito: a demonstração não pode cair no meio por expiração
 * de trial (o cron `trialExpiry` roda 06:00 e mexe em assinatura). `valid_until` é calculado
 * por quem chama, a partir de uma data explícita — nunca de `now()` dentro da decisão, senão
 * duas chamadas discordam e o teste não consegue afirmar nada.
 */
function assinaturaDaDemonstracao({ validaAte, convertidaEm }) {
  if (!(validaAte instanceof Date)) throw new Error('tenant-demo: validaAte precisa ser Date.');
  if (!(convertidaEm instanceof Date)) throw new Error('tenant-demo: convertidaEm precisa ser Date.');
  return {
    feature: 'LEAD_MANAGER',
    status: 'ACTIVE',
    valid_until: validaAte,
    converted_at: convertidaEm,
  };
}

/**
 * Configuração do Lead Manager da unidade. PURA.
 *
 * `school_name` é o nome da coluna, não do negócio: o campo é o CONTEXTO que a IA recebe e o
 * título que algumas telas mostram. Em unidade que não é escola ele vale igual — e trocar o
 * nome da coluna seria migração destrutiva numa tabela que o dashboard lê. Fica o nome antigo
 * com o conteúdo certo.
 *
 * `available_instruments` fica VAZIO: é a lista de cursos de escola de música, e preencher com
 * "especialidades médicas" faria o prompt da assistente oferecer procedimento clínico — que é
 * exatamente o que ela não pode fazer. Lista vazia = o template não oferece nada.
 */
function configDaUnidade({ nomeExibido }) {
  if (!nomeExibido) throw new Error('tenant-demo: nomeExibido é obrigatório.');
  return {
    school_name: nomeExibido,
    system_prompt_override: null,  // null = usa o template padrão do produto (é ele que se mostra)
    available_instruments: [],     // ver o comentário acima — vazio é decisão
    business_hours: {
      mon: '08:00-18:00', tue: '08:00-18:00', wed: '08:00-18:00',
      thu: '08:00-18:00', fri: '08:00-17:00', sat: '08:00-12:00', sun: 'closed',
    },
    notification_whatsapp: '',     // (3) sem destino, `notificacao` não tem para onde avisar
  };
}

/**
 * Perfil da assistente + modos de automação. PURA.
 *
 * `nao_falar` é a trava de SAÍDA por configuração (migr 119, lida pelo autoReply e pelos
 * rascunhos de renovação). Aqui ela carrega o que uma clínica não pode deixar a IA afirmar.
 * Ela NÃO substitui a trava de código `temaProibido.js`, que já barra agenda, valores,
 * contrato, jurídico e reclamação na entrada E na saída — soma-se a ela.
 */
function perfilDaAssistente() {
  return {
    nome_ia: 'Janis',
    modo_comercial: 'semi',          // (4) IA sugere, recepção aprova — o que a demo mostra
    modo_fora_horario: 'semi',
    modo_fds: 'semi',
    primeira_resposta_auto: true,
    qualificacao_auto: true,
    proposta_sempre_manual: true,
    agendamento_sempre_manual: true,
    ramo_atividade: 'clínica ortopédica',
    objetivo_conversa: 'entender a necessidade e encaminhar o contato à recepção para agendar avaliação',
    estilo_ia: 'acolhedora',
    comportamento_ia:
      'Acolhe, confirma o que entendeu e encaminha para a recepção. Nunca orienta conduta clínica, '
      + 'nunca interpreta exame, nunca confirma horário nem valor por conta própria.',
    nao_falar: [
      'diagnóstico ou interpretação de exame',
      'indicação de medicamento, dose ou tratamento',
      'prazo de recuperação ou prognóstico',
      'cobertura de convênio',
    ],
    contexto_ia:
      'Clínica ortopédica de demonstração. Atende consultas, exames de imagem e programas de '
      + 'reabilitação. A recepção confirma agenda, valores e convênio — a assistente não.',
    renovacao_habilitada: true,   // a tela de Renovações precisa parecer uma unidade normal
    renovacao_auto_envio: false,  // (4) NUNCA envia sozinho
    renovacao_orientacao:
      'Lembrar do encerramento do programa e oferecer a reavaliação com o ortopedista. '
      + 'Não afirmar data, horário nem valor — quem confirma é a recepção.',
    boas_vindas_modo: 'desligado', // módulo de boas-vindas fora do escopo desta demonstração
    updated_by: 'seed-demo-mf8',
  };
}

/**
 * `true` quando o tenant pode receber (e perder) o cenário de demonstração.
 *
 * PURA de propósito — mas ela NÃO é a trava, é o AVISO. A trava de verdade é a subconsulta que
 * exige `is_demo` dentro de cada INSERT (ver migr 187 e `deploy/seed-demo-mf8.js`), porque
 * guarda em JavaScript é guarda que um `if` esquecido contorna.
 *
 * `undefined` conta como false: código rodando contra banco SEM a migr 187 enxerga todo tenant
 * como real e recusa tudo. Falha fechada.
 */
function ehTenantDeDemonstracao(t) {
  return Boolean(t && t.is_demo === true);
}

const MOTIVO_RECUSA =
  'RECUSADO: este tenant do Lead Manager não tem is_demo = true. O seed APAGA e reescreve o '
  + 'cenário, e só tenant de demonstração pode ser apagado e recriado. Se a intenção é mexer '
  + 'numa unidade real, este script não é o caminho.';

/**
 * ⭐ A TRAVA DE VERDADE, e é SQL, não JavaScript.
 *
 * Devolve o fragmento que resolve o tenant_id a partir de uma subconsulta que exige `is_demo`.
 * Em tenant real a subconsulta devolve NULL, a coluna é NOT NULL e a transação inteira cai —
 * então errar grava NADA, nunca grava na unidade errada.
 *
 * @param {number} n  posição do parâmetro ($1, $2…) que carrega o uuid do tenant
 */
function sqlTenantSoSeDemo(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error('tenant-demo: posição de parâmetro inválida.');
  return `(SELECT id FROM lead_manager.tenants WHERE id = $${n} AND is_demo)`;
}

/**
 * O PLANO DE ESCRITA do provisionamento — mesmo formato do plano do cenário.
 *
 * ⚠ POR QUE ISTO EXISTE, E É O ACHADO MAIS IMPORTANTE DESTE ARQUIVO
 *
 * A primeira versão deste script escrevia o cenário por um PLANO (conferido pelas três camadas)
 * e o provisionamento por quatro INSERTs escritos à mão, fora do plano. Ou seja: quatro tabelas
 * gravadas SEM conferência nenhuma, num script cuja razão de existir é conferir antes de gravar.
 *
 * É o MESMO furo que matou a gravação do cenário do dashboard em 31/10/2026 — "a lista das
 * tabelas a conferir era a lista das tabelas conferidas" — só que um nível acima: ali faltou uma
 * tabela na lista; aqui faltava um CAMINHO DE ESCRITA inteiro. E o sintoma seria igual: suíte
 * verde, e o `psql` reclamando de uma coluna.
 *
 * A regra que sai disso: toda tabela que o seed escreve sai de um plano, e os planos são os
 * únicos caminhos de escrita. `test/demo-mf8.test.js` confere isso contando as tabelas de ambos
 * os planos contra o que o esquema congelado tem.
 *
 * `portao: false` em `tenants` é a única exceção, e é geométrica, não de descuido: o portão é a
 * subconsulta `... WHERE id = $1 AND is_demo`, e na linha que CRIA o tenant ela não teria o que
 * encontrar. O que protege essa linha é outra coisa, dita por extenso: o uuid é derivado do slug
 * (sempre o mesmo), o `name` é conferido antes e o script recusa marcar como demonstração um
 * tenant que já exista com `is_demo = false`.
 *
 * @param {{tenantId: string, hoje: string, slug: string, maisDias: (d: string, n: number) => string,
 *          instante: (d: string, dias: number, hhmm: string) => string}} arg
 */
function planoProvisionamento({ tenantId, hoje, slug, maisDias, instante }) {
  if (!tenantId) throw new Error('tenant-demo: tenantId é obrigatório.');
  if (!slug) throw new Error('tenant-demo: slug é obrigatório.');
  if (typeof maisDias !== 'function' || typeof instante !== 'function') {
    throw new Error('tenant-demo: maisDias e instante vêm de cenario-mf8 (as datas têm um fuso só).');
  }
  const t = tenantDeDemonstracao({ slug });
  const cfg = configDaUnidade({ nomeExibido: t.name });
  const perfil = perfilDaAssistente();

  return [
    {
      tabela: 'lead_manager.tenants',
      portao: false,   // ver o cabeçalho desta função — é a linha que CRIA o portão
      colunas: ['id', 'name', 'is_demo', 'lead_manager_active',
        'evolution_instance', 'evolution_token_enc', 'zapi_token'],
      chaveConflito: ['id'],
      linhas: [[tenantId, t.name, t.is_demo, t.lead_manager_active,
        t.evolution_instance, t.evolution_token_enc, t.zapi_token]],
    },
    {
      tabela: 'lead_manager.tenant_subscriptions',
      colunas: ['tenant_id', 'feature', 'status', 'valid_until', 'converted_at'],
      chaveConflito: ['tenant_id', 'feature'],
      linhas: [[tenantId, 'LEAD_MANAGER', 'ACTIVE',
        instante(hoje, -365, '12:00'), instante(hoje, 0, '12:00')]],
    },
    {
      tabela: 'lead_manager.tenant_lead_config',
      colunas: ['tenant_id', 'school_name', 'system_prompt_override',
        'available_instruments', 'business_hours', 'notification_whatsapp'],
      chaveConflito: ['tenant_id'],
      linhas: [[tenantId, cfg.school_name, cfg.system_prompt_override,
        cfg.available_instruments, JSON.stringify(cfg.business_hours), cfg.notification_whatsapp]],
    },
    {
      tabela: 'lead_manager.automacao_config',
      colunas: ['tenant_id', 'nome_ia', 'modo_comercial', 'modo_fora_horario', 'modo_fds',
        'primeira_resposta_auto', 'qualificacao_auto', 'proposta_sempre_manual',
        'agendamento_sempre_manual', 'ramo_atividade', 'objetivo_conversa', 'estilo_ia',
        'comportamento_ia', 'nao_falar', 'contexto_ia', 'renovacao_habilitada',
        'renovacao_auto_envio', 'renovacao_orientacao', 'boas_vindas_modo', 'updated_by'],
      chaveConflito: ['tenant_id'],
      linhas: [[tenantId, perfil.nome_ia, perfil.modo_comercial, perfil.modo_fora_horario,
        perfil.modo_fds, perfil.primeira_resposta_auto, perfil.qualificacao_auto,
        perfil.proposta_sempre_manual, perfil.agendamento_sempre_manual, perfil.ramo_atividade,
        perfil.objetivo_conversa, perfil.estilo_ia, perfil.comportamento_ia, perfil.nao_falar,
        perfil.contexto_ia, perfil.renovacao_habilitada, perfil.renovacao_auto_envio,
        perfil.renovacao_orientacao, perfil.boas_vindas_modo, perfil.updated_by]],
    },
  ];
}

module.exports = {
  CHAVE_DO_LEAD_MANAGER, NOME_DO_TENANT, MOTIVO_RECUSA,
  tenantDeDemonstracao, assinaturaDaDemonstracao, configDaUnidade, perfilDaAssistente,
  ehTenantDeDemonstracao, sqlTenantSoSeDemo, planoProvisionamento,
};
