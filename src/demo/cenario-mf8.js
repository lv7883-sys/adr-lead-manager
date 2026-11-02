'use strict';
//
// cenario-mf8.js — O CENÁRIO fictício da demonstração de 04/11/2026, e o PLANO de escrita dele.
// PURO: nenhuma linha deste arquivo toca banco.
//
// ─── NÃO HÁ SORTEIO NENHUM AQUI, E ISSO É DECISÃO ────────────────────────────────────────────
//
// A regra que este projeto pagou para aprender diz que o sorteio nunca toca em total de dinheiro:
// valores fechados vêm de tabela declarada e o aleatório só distribui dentro dela, com semente
// fixa. Aqui a regra é aplicada na versão forte: **nada é sorteado**. O cenário inteiro é uma
// tabela declarada e as únicas contas são deslocamentos de DIA sobre uma data recebida.
//
// Por quê ir além do pedido: semente fixa ainda exige confiar na semente — e no gerador, e na
// ordem em que ele é consumido, que muda sem ninguém notar quando alguém insere um `if` no meio
// do laço. Tabela declarada é conferível por LEITURA: quem revisa o PR vê as 12 conversas e os
// 9 contratos, não um programa que promete produzi-los.
//
// ⚠ E sobre dinheiro, especificamente: NÃO HÁ dinheiro nenhum neste cenário, e não por economia
// de esforço. `lead_manager.service_account` não tem coluna de valor (verificado em código: migr
// 060 cria a tabela; 072, 105 e 185 são os únicos ALTERs e nenhum adiciona valor). E o texto dos
// rascunhos da Janis não pode afirmar valor — `src/temaProibido.js` barra "valores" na entrada E
// na saída. Então um preço no cenário seria, ao mesmo tempo, dado que o schema não guarda e
// frase que a trava do produto recusaria. A tabela de planos abaixo é de RÓTULOS, sem preço.
//
// ─── O QUE A DEMONSTRAÇÃO CONTA, EM 10 MINUTOS ───────────────────────────────────────────────
//
//   1. Caixa de Entrada (aba "Todas"): 12 conversas de WhatsApp, 3 com entrada não lida.
//   2. Aba "Leads": 8 delas são lead, em estágios diferentes do funil — novo, qualificando,
//      qualificado, matriculado, perdido.
//   3. Aba "Outras": 4 não são lead (fornecedor, cobrança de convênio, contato interno) — mostra
//      que o sistema SEPARA, em vez de tratar todo número como oportunidade.
//   4. A assistente: 5 conversas têm resposta da Janis já enviada e 2 têm SUGESTÃO esperando
//      aprovação (é o modo 'semi' — a IA escreve, a recepção decide).
//   5. Aba "Renovações" e a tela de Renovações: 9 contratos, 3 na janela (D-10, D-2 e um vencido
//      há 20 dias), com rascunho de renovação pronto para a recepção enviar.
//   6. O lembrete de renovação de um dos contratos vai para a FILHA que paga, não para o
//      paciente — porque a régua resolve o pagador antes do beneficiário.
//
// ─── NOMES, TELEFONES E A LGPD ───────────────────────────────────────────────────────────────
//
// Todas as pessoas são inventadas. Os telefones estão no bloco 19 99000-00XX, sequencial e
// visivelmente falso — quem lê a tela vê que é fictício. Isso NÃO é garantia de que o número
// não pertença a alguém: no Brasil não existe faixa reservada para ficção. O que garante que
// nada sai é o tenant: `lead_manager_active = false` (fora de todo laço de fundo) e nenhum token
// de Evolution/Z-API (`outbound.credsForTenant` não resolve remetente). Ver src/demo/tenant-demo.js.
//
// Nenhum texto menciona diagnóstico, exame, medicamento ou prognóstico: o assunto das conversas
// é administrativo (quero marcar, qual endereço, meu programa está terminando). Dado de saúde
// fictício ainda ensina o público que o produto trata dado de saúde — e não trata.
//
// E nenhum texto usa nome de recepcionista. Quando precisa de nome, é a Janis (nome_ia) — regra
// do projeto, e a trava de saída já barra "aqui é a <nome da recepcionista>".
//
const crypto = require('node:crypto');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Identidade estável sem sorteio: o uuid de cada linha é derivado de uma CHAVE declarada.
// Rodar o seed duas vezes produz exatamente os mesmos uuids — então a gravação é repetível e o
// `ON CONFLICT (id)` do script faz o segundo passe não duplicar nada.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const NAMESPACE = 'adr-lead-manager/demo-mf8/2026-11-04';

/** uuid determinístico (formato v5: sha1 do namespace + chave). PURA. */
function idDe(tipo, chave) {
  if (!tipo || !chave) throw new Error('cenario-mf8: idDe exige tipo e chave.');
  const h = crypto.createHash('sha1').update(`${NAMESPACE}|${tipo}|${chave}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;   // versão 5
  b[8] = (b[8] & 0x3f) | 0x80;   // variante RFC 4122
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Datas: deslocamento de DIAS sobre uma data recebida, e o fuso dito por extenso.
//
// America/Sao_Paulo é UTC-03:00 o ano inteiro desde 2019 (horário de verão extinto), então o
// deslocamento é constante e o carimbo pode ser montado como texto. Montar com `new Date()` do
// Node pegaria o fuso da MÁQUINA — e a máquina de quem roda o seed não é a do apresentador.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const FUSO = '-03:00';

// ⭐ A ÂNCORA DA APRESENTAÇÃO, e por que ela é constante declarada e não só um argumento.
//
// Todas as vigências de contrato saem de deslocamentos de dia sobre esta data. Mudá-la move as
// dez datas — medido: âncora 04/11 dá o primeiro vencimento em 25/09; âncora 02/11 dá 23/09.
//
// E isso deixou de ser detalhe interno em 02/11/2026, quando a frente do dashboard decidiu
// ESPELHAR estes dez contratos no BI (nomes, serviços e vigências), porque o público da
// apresentação é uma consultoria tributária e a tela de Renovações não pode discordar do painel
// de contratos. As datas dela são literais, fixadas no outro repositório.
//
// Logo: um `--hoje` diferente aqui faria os dois lados voltarem a discordar — e em silêncio, com
// cada tela certa sozinha. `deploy/seed-demo-mf8.js` RECUSA outra âncora sem `--reancorar`, para
// que mover as datas seja uma decisão escrita e não um argumento digitado por hábito.
const ANCORA_DA_APRESENTACAO = '2026-11-04';

/** 'YYYY-MM-DD' + n dias → 'YYYY-MM-DD'. PURA, em UTC (sem fuso: é data, não instante). */
function maisDias(dataISO, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dataISO));
  if (!m) throw new Error(`cenario-mf8: data precisa ser 'YYYY-MM-DD', veio ${JSON.stringify(dataISO)}.`);
  if (!Number.isInteger(n)) throw new Error('cenario-mf8: deslocamento de dias precisa ser inteiro.');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** instante com fuso explícito: (data, dias atrás, 'HH:MM') → '2026-11-02T14:05:00-03:00'. PURA. */
function instante(dataISO, diasAtras, hhmm) {
  if (!/^\d{2}:\d{2}$/.test(String(hhmm))) {
    throw new Error(`cenario-mf8: hora precisa ser 'HH:MM', veio ${JSON.stringify(hhmm)}.`);
  }
  return `${maisDias(dataISO, -diasAtras)}T${hhmm}:00${FUSO}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// TABELA DECLARADA DE PLANOS. Rótulos, sem preço (ver o cabeçalho). `periodicidade` é um de-para
// controlado pelo CHECK da migr 060 — mensal|trimestral|semestral|anual|outro.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const PLANOS = Object.freeze({
  reab_tri:   { servico: 'Reabilitação de joelho',    plano: 'Programa 12 semanas',   periodicidade: 'trimestral' },
  reab_sem:   { servico: 'Reabilitação de ombro',     plano: 'Programa 24 semanas',   periodicidade: 'semestral' },
  acomp_sem:  { servico: 'Acompanhamento ortopédico', plano: 'Semestral',             periodicidade: 'semestral' },
  acomp_anual:{ servico: 'Acompanhamento ortopédico', plano: 'Anual',                 periodicidade: 'anual' },
  pilates:    { servico: 'Pilates clínico',           plano: 'Mensal 2x/semana',      periodicidade: 'mensal' },
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AS 12 CONVERSAS. Tabela declarada — é isto que a revisão do PR lê.
//
// `mensagens`: [diasAtras, 'HH:MM', quem, texto]
//    quem = 'cliente'  → lead_manager.messages (role 'USER') — entrada de quem escreveu
//           'recepcao' → lead_manager.staff_outbound_samples — resposta REAL da recepção
//           'ia'       → lead_manager.pending_approvals — resposta da assistente
//                        (status 'APPROVED' = já foi; 'PENDING' = esperando a recepção aprovar)
// São as TRÊS fontes que a timeline do produto mescla (src/timeline.js) — não há uma quarta, e
// escrever a resposta da recepção em `messages` faria a bolha sair do lado errado.
//
// `lead`: null quando a conversa NÃO é lead. `naoLida` só marca a conversa; quem calcula o
// contador é a consulta do inbox (entrada do cliente depois de `last_read_at`).
// ─────────────────────────────────────────────────────────────────────────────────────────────
const CONVERSAS = Object.freeze([
  {
    chave: 'marina', nome: 'Marina Alvares', telefone: '5519990000001',
    naoLida: true,
    lead: { status: 'NEW', intent: 'SCHEDULE_INTEREST', origem: 'whatsapp' },
    mensagens: [
      [0, '09:12', 'cliente', 'Bom dia! Vi a clínica no Google. Vocês atendem joelho?'],
      [0, '09:13', 'cliente', 'Queria marcar uma avaliação, se possível essa semana'],
      [0, '09:15', 'ia:PENDING', 'Bom dia, Marina! Aqui é a Janis, assistente da clínica. Sim, atendemos ortopedia de joelho. Vou passar seu contato para a recepção confirmar a primeira data disponível, pode ser?'],
    ],
  },
  {
    chave: 'rogerio', nome: 'Rogério Pontes', telefone: '5519990000002',
    naoLida: false,
    lead: { status: 'QUALIFYING', intent: 'GENERAL_INFO', origem: 'whatsapp' },
    mensagens: [
      [2, '14:40', 'cliente', 'Boa tarde, a clínica fica perto da estação?'],
      [2, '14:41', 'ia:APPROVED', 'Boa tarde, Rogério! Aqui é a Janis. Ficamos a cerca de dez minutos a pé da estação. Posso pedir para a recepção te mandar a localização no mapa?'],
      [2, '14:52', 'cliente', 'Pode sim. E vocês atendem à tarde?'],
      [2, '15:02', 'recepcao', 'Oi Rogério! Seguem a localização e os horários de tarde. Qualquer dúvida, é só chamar aqui.'],
      [1, '10:20', 'cliente', 'Obrigado! Vou ver com a minha esposa e retorno'],
    ],
  },
  {
    chave: 'helena', nome: 'Helena Marques', telefone: '5519990000003',
    naoLida: true,
    lead: { status: 'QUALIFIED', intent: 'SCHEDULE_INTEREST', origem: 'indicacao' },
    mensagens: [
      [4, '11:05', 'cliente', 'Oi! Fui indicada por uma amiga que fez reabilitação com vocês'],
      [4, '11:06', 'ia:APPROVED', 'Olá, Helena! Aqui é a Janis, assistente da clínica. Que bom receber indicação. Me conta rapidinho o que você precisa, que eu já encaminho para a recepção?'],
      [4, '11:14', 'cliente', 'Preciso de uma avaliação de ombro, tenho dificuldade de levantar o braço'],
      [4, '11:30', 'recepcao', 'Oi Helena! Vamos agendar a avaliação. Vou te passar as opções de horário por aqui.'],
      [3, '09:40', 'cliente', 'Perfeito, aguardo'],
      [0, '08:55', 'cliente', 'Bom dia, consegui confirmar com o trabalho. Pode marcar!'],
    ],
  },
  {
    chave: 'caio', nome: 'Caio Ribeiro', telefone: '5519990000004',
    naoLida: false,
    lead: { status: 'CONVERTED', intent: 'SCHEDULE_INTEREST', origem: 'whatsapp', desfecho: 'matriculado', desfechoDiasAtras: 12 },
    contrato: { plano: 'reab_tri', iniDias: -12, fimDias: 78, status: 'Ativo', pagadorProprio: true },
    mensagens: [
      [20, '16:10', 'cliente', 'Boa tarde, quero começar a reabilitação do joelho'],
      [20, '16:12', 'ia:APPROVED', 'Boa tarde, Caio! Aqui é a Janis. Vou encaminhar para a recepção montar seu programa com o ortopedista.'],
      [19, '10:05', 'recepcao', 'Oi Caio! Tudo certo para começar. A recepção te manda o plano de sessões por aqui.'],
      [12, '09:30', 'cliente', 'Fechado, comecei hoje. Obrigado!'],
    ],
  },
  {
    chave: 'sueli', nome: 'Sueli Tavares', telefone: '5519990000005',
    naoLida: false,
    lead: { status: 'PERDIDO', intent: 'SCHEDULE_INTEREST', origem: 'whatsapp', desfecho: 'nao_matriculado_horario', desfechoDiasAtras: 6, desfechoNotas: 'Só poderia depois das 19h; a clínica fecha às 18h.' },
    mensagens: [
      [9, '17:48', 'cliente', 'Olá, vocês atendem depois das 19h?'],
      [9, '17:50', 'ia:APPROVED', 'Olá, Sueli! Aqui é a Janis. Nosso atendimento vai até o fim da tarde. Vou pedir para a recepção te confirmar o último horário do dia, pode ser?'],
      [8, '08:20', 'recepcao', 'Oi Sueli! Nosso último horário é às 17h. Se abrir algo mais tarde, eu te aviso.'],
      [6, '19:30', 'cliente', 'Infelizmente não consigo sair do trabalho antes. Obrigada!'],
    ],
  },
  {
    chave: 'beatriz', nome: 'Beatriz Camargo', telefone: '5519990000006',
    naoLida: false,
    lead: { status: 'CONVERTED', intent: 'SCHEDULE_INTEREST', origem: 'indicacao', desfecho: 'matriculado', desfechoDiasAtras: 80, abordaRenovacao: true },
    contrato: { plano: 'reab_sem', iniDias: -80, fimDias: 10, status: 'Ativo', pagadorProprio: true },
    toque: {
      marco: 'D-10',
      status: 'pendente',
      estrategia: 'Programa de 24 semanas encerra em 10 dias. Ela veio por indicação e nunca faltou — vale oferecer a reavaliação antes do fim.',
      rascunho: 'Oi, Beatriz! Aqui é a Janis, da clínica. Seu programa de reabilitação de ombro encerra no dia {fim}. Quer que eu peça para a recepção reservar um retorno com o ortopedista para reavaliar e seguir daqui?',
    },
    mensagens: [
      [80, '10:00', 'cliente', 'Oi! Minha vizinha fez reabilitação de ombro com vocês e me indicou'],
      [80, '10:04', 'ia:APPROVED', 'Olá, Beatriz! Aqui é a Janis. Obrigada pela confiança. Vou encaminhar para a recepção te explicar como funciona o programa.'],
      [79, '09:15', 'recepcao', 'Oi Beatriz! Programa montado, começamos na segunda.'],
      [3, '18:22', 'cliente', 'Boa tarde! Minha última sessão é esse mês, né?'],
    ],
  },
  {
    chave: 'otavio', nome: 'Otávio Bernardes', telefone: '5519990000007',
    naoLida: false,
    // O pagador é a FILHA — é este contrato que mostra a régua resolvendo pagador antes de
    // beneficiário. O toque de renovação vai para o telefone dela, não dele.
    pagador: { chave: 'renata', nome: 'Renata Bernardes', telefone: '5519990000013' },
    lead: null,
    contrato: { plano: 'acomp_sem', iniDias: -178, fimDias: 2, status: 'Ativo', pagadorProprio: false },
    toque: {
      marco: 'D-2',
      status: 'pendente',
      estrategia: 'Quem paga é a filha, Renata — o toque vai para o telefone dela. O acompanhamento do pai encerra em 2 dias.',
      rascunho: 'Oi, Renata! Aqui é a Janis, da clínica. O acompanhamento ortopédico do seu pai, o Sr. Otávio, encerra no dia {fim}. Quer que eu peça para a recepção falar com você sobre a continuidade?',
    },
    mensagens: [
      [30, '15:00', 'cliente', 'Boa tarde, aqui é o Otávio. Minha filha cuida dos meus horários'],
      [30, '15:05', 'recepcao', 'Oi Sr. Otávio! Anotado aqui: os avisos do acompanhamento vão para a Renata.'],
    ],
  },
  {
    chave: 'ivone', nome: 'Ivone Peixoto', telefone: '5519990000008',
    naoLida: false,
    lead: null,
    contrato: { plano: 'pilates', iniDias: -50, fimDias: -20, status: 'Inativo', pagadorProprio: true },
    toque: {
      marco: 'D-2',
      status: 'enviado',
      enviadoDiasAtras: 22,
      estrategia: 'Mensal de pilates clínico venceu e ela não respondeu ao toque. Candidata a reconquista.',
      rascunho: 'Oi, Ivone! Aqui é a Janis, da clínica. Seu mês de pilates clínico encerra no dia {fim}. Quer que eu peça para a recepção reservar sua vaga do próximo mês?',
    },
    mensagens: [
      [50, '08:40', 'cliente', 'Bom dia, quero fazer pilates clínico 2x por semana'],
      [50, '08:45', 'recepcao', 'Oi Ivone! Vaga reservada nas terças e quintas.'],
    ],
  },
  {
    chave: 'tadeu', nome: 'Tadeu Farias — Ortovida Materiais', telefone: '5519990000009',
    naoLida: false,
    lead: { status: 'NOT_LEAD', intent: 'OUT_OF_SCOPE', origem: 'whatsapp', desfecho: 'nao_e_lead', desfechoDiasAtras: 5, desfechoNotas: 'Fornecedor de materiais, não é paciente.' },
    mensagens: [
      [5, '11:20', 'cliente', 'Bom dia! Sou da Ortovida, a entrega das faixas elásticas sai amanhã'],
      [5, '11:35', 'recepcao', 'Obrigada, Tadeu! Pode entregar pela manhã.'],
    ],
  },
  {
    chave: 'clarice', nome: 'Clarice Rendell', telefone: '5519990000010',
    naoLida: true,
    lead: { status: 'NEW', intent: 'GENERAL_INFO', origem: 'whatsapp' },
    mensagens: [
      [0, '10:48', 'cliente', 'Oi! Meu convênio cobre a avaliação com vocês?'],
      [0, '10:50', 'ia:PENDING', 'Olá, Clarice! Aqui é a Janis, assistente da clínica. Cobertura de convênio é a recepção que confirma — não quero te passar informação errada. Já estou encaminhando para eles te responderem por aqui.'],
    ],
  },
  {
    chave: 'nilton', nome: 'Nilton Siqueira', telefone: '5519990000011',
    naoLida: false,
    lead: { status: 'QUALIFYING', intent: 'SCHEDULE_INTEREST', origem: 'whatsapp' },
    mensagens: [
      // Áudio: mostra a transcrição. `midia` cai em media_type/media_transcription da mensagem.
      [1, '13:05', 'cliente', '', { midia: 'audio', transcricao: 'Oi, boa tarde. Eu torci o pé jogando bola no fim de semana e queria saber se vocês atendem sem encaminhamento.' }],
      [1, '13:09', 'ia:APPROVED', 'Boa tarde, Nilton! Aqui é a Janis. Atendemos sim, sem necessidade de encaminhamento. Vou passar para a recepção te oferecer um horário.'],
      [1, '13:40', 'cliente', 'Valeu! Pode ser quinta de manhã?'],
    ],
  },
  {
    chave: 'vera', nome: 'Vera Lúcia Andrade', telefone: '5519990000012',
    naoLida: false,
    lead: { status: 'QUALIFIED', intent: 'SCHEDULE_INTEREST', origem: 'site' },
    mensagens: [
      [7, '09:00', 'cliente', 'Olá, preenchi o formulário no site e ninguém me respondeu ainda'],
      [7, '09:02', 'ia:APPROVED', 'Olá, Vera! Aqui é a Janis. Peço desculpas pela espera — já localizei seu cadastro e estou encaminhando para a recepção te atender agora.'],
      [7, '09:35', 'recepcao', 'Oi Vera! Desculpe a demora. Vou te passar os horários de avaliação ainda hoje.'],
      [5, '17:10', 'cliente', 'Obrigada! Prefiro de manhã'],
    ],
  },
]);

// Contratos SEM conversa — existem só para o gráfico de vencimentos da tela de Renovações ter
// barras em mais de uma faixa. Pessoa com cadastro e contrato, sem WhatsApp: é o caso real de
// quem foi atendido antes de a unidade usar o Regente.
const CONTRATOS_SEM_CONVERSA = Object.freeze([
  { chave: 'wilson',  nome: 'Wilson Dahlke',     telefone: '5519990000021', plano: 'acomp_anual', iniDias: -320, fimDias: 45, status: 'Ativo' },
  { chave: 'eunice',  nome: 'Eunice Portilho',   telefone: '5519990000022', plano: 'reab_tri',    iniDias: -60,  fimDias: 30, status: 'Ativo' },
  { chave: 'jonas',   nome: 'Jonas Vilalba',     telefone: '5519990000023', plano: 'pilates',     iniDias: -15,  fimDias: 15, status: 'Ativo' },
  { chave: 'lurdes',  nome: 'Lurdes Katayama',   telefone: '5519990000024', plano: 'reab_sem',    iniDias: -175, fimDias: 7,  status: 'Ativo' },
  { chave: 'armando', nome: 'Armando Beleze',    telefone: '5519990000025', plano: 'acomp_sem',   iniDias: -185, fimDias: -5, status: 'Não Renovado' },
  { chave: 'dirce',   nome: 'Dirce Monteluz',    telefone: '5519990000026', plano: 'pilates',     iniDias: -70,  fimDias: -40, status: 'Inativo' },
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// O PLANO DE ESCRITA.
//
// Formato: uma lista ORDENADA (a ordem é a das chaves estrangeiras) de
//   { tabela, colunas: [nome…], linhas: [[valor…]…], chaveConflito: [nome…] }
//
// Por que o plano é DADO e não código que executa INSERT: é dele que as três camadas de
// conferência derivam a lista de tabelas a conferir. A lição de 31/10/2026 no dashboard foi que
// "a lista das tabelas a conferir era a lista das tabelas conferidas" — uma segunda lista
// escrita à mão, que esqueceu a sexta de oito tabelas com 22 testes verdes. Aqui não existe
// segunda lista: `tabelasDoPlano(plano)` é a única, e sai do próprio plano.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `true` se a conversa tem contrato (e portanto pessoa no cadastro). */
const _temContrato = (c) => Boolean(c.contrato);

/**
 * O plano completo de escrita do cenário. PURA.
 *
 * @param {{tenantId: string, hoje: string}} arg  hoje = 'YYYY-MM-DD' (dia da apresentação)
 * @returns {Array<{tabela: string, colunas: string[], linhas: any[][], chaveConflito: string[]}>}
 */
function plano({ tenantId, hoje }) {
  if (!tenantId) throw new Error('cenario-mf8: tenantId é obrigatório.');
  maisDias(hoje, 0);   // valida o formato de `hoje` cedo, com a mensagem do validador

  const pessoas = [];        // [chave, nome, telefone]
  const contratos = [];      // {chave, plano, ini, fim, status, beneficiario, pagador}
  const conversas = [];
  const msgsCliente = [];
  const saidasRecepcao = [];
  const sugestoesIa = [];
  const leads = [];
  const toques = [];

  // Pessoas e contatos vêm de TRÊS origens no cenário: quem tem conversa, o pagador declarado
  // de um contrato, e quem só tem contrato. Um Map por chave garante uma pessoa por chave.
  const porChave = new Map();
  const registraPessoa = (chave, nome, telefone) => {
    if (!porChave.has(chave)) porChave.set(chave, { chave, nome, telefone });
    return porChave.get(chave);
  };

  for (const c of CONVERSAS) {
    const convId = idDe('conversa', c.chave);
    const ultima = c.mensagens.reduce(
      (acc, [d, h]) => {
        const t = instante(hoje, d, h);
        return !acc || t > acc ? t : acc;
      }, null);
    // ⭐ A PRIMEIRA mensagem é o nascimento do lead — e isso não é estética.
    //
    // A primeira versão dava a TODOS os leads o mesmo `created_at`, 90 dias antes da âncora. O
    // Kanban filtra por `leads.created_at >= now() - <período>` e o período PADRÃO da tela é
    // 30 DIAS (metrics.js, KANBAN_DEFAULT_PERIOD) — então as seis colunas apareciam ZERADAS,
    // enquanto a Caixa de Entrada mostrava as 12 conversas normalmente.
    //
    // O modo de falha é o pior tipo: a tela não dava erro, não dava aviso, e cada metade estava
    // certa sozinha. Só foi descoberto quando o Leo ABRIU A TELA e mandou o print — nenhuma das
    // minhas conferências o pegaria, porque todas mediam o banco e nenhuma media o filtro padrão
    // de uma tela do outro repositório. Medido em 02/11/2026.
    //
    // Ancorar na primeira mensagem conserta e é mais honesto: o lead nasce quando a pessoa
    // escreve. Quem conversou hoje é lead de hoje; a Beatriz, que escreveu há 80 dias, segue
    // fora dos 30 dias — e deve ficar, porque ela é cliente antiga cujo contrato está vencendo.
    const primeira = c.mensagens.reduce(
      (acc, [d, h]) => {
        const t = instante(hoje, d, h);
        return !acc || t < acc ? t : acc;
      }, null);

    conversas.push([
      convId, tenantId, 'whatsapp', c.telefone, 'DIRECT',
      ultima,                              // last_activity_at — é o que ordena a lista
      c.naoLida ? null : ultima,           // last_read_at: null = tem entrada não lida
      ultima,                              // updated_at (último inbound, no produto)
      primeira,                            // created_at — a conversa nasce na 1ª mensagem
    ]);

    // Cadastro: só quem tem contrato entra em person/contact_point. Lead sem contrato ainda não
    // é cliente da unidade — inventar cadastro para ele faria o funil mentir.
    if (_temContrato(c)) registraPessoa(c.chave, c.nome, c.telefone);
    if (c.pagador) registraPessoa(c.pagador.chave, c.pagador.nome, c.pagador.telefone);

    if (_temContrato(c)) {
      const p = PLANOS[c.contrato.plano];
      if (!p) throw new Error(`cenario-mf8: plano desconhecido ${JSON.stringify(c.contrato.plano)}.`);
      contratos.push({
        chave: c.chave, p,
        ini: maisDias(hoje, c.contrato.iniDias),
        fim: maisDias(hoje, c.contrato.fimDias),
        status: c.contrato.status,
        beneficiario: c.chave,
        pagador: c.contrato.pagadorProprio ? c.chave : c.pagador.chave,
      });
    }

    for (const [diasAtras, hhmm, quem, texto, extra] of c.mensagens) {
      const quando = instante(hoje, diasAtras, hhmm);
      const mid = idDe('mensagem', `${c.chave}|${diasAtras}|${hhmm}|${quem}`);
      if (quem === 'cliente') {
        msgsCliente.push([
          mid, tenantId, convId, 'inbound', 'USER',
          `demo-mf8-${mid}`,                      // external_message_id (id do WhatsApp)
          c.nome,                                 // sender = pushName
          texto || null,
          extra && extra.midia ? extra.midia : null,
          extra && extra.transcricao ? extra.transcricao : null,
          quando,
        ]);
      } else if (quem === 'recepcao') {
        saidasRecepcao.push([
          mid, tenantId, 'whatsapp', c.telefone, `demo-mf8-${mid}`,
          'web',          // source = device da Evolution; 'web' é a recepção no computador
          null,           // sender (pushName da unidade) — vazio: a demo não mostra nome de recepção
          texto,
          false,          // is_group
          quando,
        ]);
      } else if (quem === 'ia:APPROVED' || quem === 'ia:PENDING') {
        if (!c.lead) {
          throw new Error(
            `cenario-mf8: a conversa ${JSON.stringify(c.chave)} tem resposta da IA mas não é lead — `
            + 'pending_approvals.lead_id é NOT NULL, então a sugestão não teria onde morar.');
        }
        sugestoesIa.push([
          mid, tenantId, idDe('lead', c.chave), convId, texto,
          quem === 'ia:APPROVED' ? 'APPROVED' : 'PENDING', quando,
        ]);
      } else {
        throw new Error(`cenario-mf8: autor desconhecido ${JSON.stringify(quem)} em ${c.chave}.`);
      }
    }

    if (c.lead) {
      const l = c.lead;
      leads.push([
        idDe('lead', c.chave), tenantId, c.nome, c.telefone,
        l.status, l.intent, l.origem,
        l.desfecho || null,
        l.desfechoNotas || null,
        l.desfechoDiasAtras == null ? null : instante(hoje, l.desfechoDiasAtras, '17:00'),
        l.abordaRenovacao === true ? true : null,
        primeira,                      // created_at — o lead nasce na 1ª mensagem (filtro do Kanban)
        ultima,                        // updated_at
      ]);
    }
  }

  for (const k of CONTRATOS_SEM_CONVERSA) {
    const p = PLANOS[k.plano];
    if (!p) throw new Error(`cenario-mf8: plano desconhecido ${JSON.stringify(k.plano)}.`);
    registraPessoa(k.chave, k.nome, k.telefone);
    contratos.push({
      chave: k.chave, p,
      ini: maisDias(hoje, k.iniDias), fim: maisDias(hoje, k.fimDias),
      status: k.status, beneficiario: k.chave, pagador: k.chave,
    });
  }

  // Toques de renovação: dependem do contrato (account_id) e da pessoa que RECEBE (pagador).
  for (const c of CONVERSAS) {
    if (!c.toque) continue;
    if (!_temContrato(c)) {
      throw new Error(`cenario-mf8: ${c.chave} tem toque de renovação sem contrato — account_id é NOT NULL.`);
    }
    const ct = contratos.find((x) => x.chave === c.chave);
    const destino = porChave.get(ct.pagador);
    const diasDoMarco = Number(String(c.toque.marco).replace('D-', ''));
    toques.push([
      idDe('toque', `${c.chave}|${c.toque.marco}`), tenantId,
      idDe('contrato', c.chave), idDe('pessoa', destino.chave),
      c.toque.marco, ct.fim, maisDias(ct.fim, -diasDoMarco),
      destino.telefone, destino.nome, c.nome, ct.p.servico,
      c.toque.estrategia,
      String(c.toque.rascunho).replace('{fim}', _dataBR(ct.fim)),
      c.toque.status,
      false,   // auto = false: NADA neste cenário foi gerado em modo automático
      c.toque.enviadoDiasAtras == null ? null : instante(hoje, c.toque.enviadoDiasAtras, '10:00'),
    ]);
  }

  const pessoasLista = [...porChave.values()];

  return [
    {
      tabela: 'lead_manager.person',
      colunas: ['id', 'tenant_id', 'display_name'],
      chaveConflito: ['id'],
      linhas: pessoasLista.map((p) => [idDe('pessoa', p.chave), tenantId, p.nome]),
    },
    {
      tabela: 'lead_manager.contact_point',
      colunas: ['id', 'tenant_id', 'person_id', 'kind', 'value_raw', 'source', 'confidence', 'proven_at'],
      chaveConflito: ['id'],
      // confidence 'provado' com proven_at: o telefone do cadastro da unidade é dado que ela
      // digitou e confirmou. 'alegado' faria a ponte do contrato×conversa ficar mais fraca do
      // que a unidade real tem — e é essa ponte que a aba Renovações usa.
      linhas: pessoasLista.map((p) => [
        idDe('contato', p.chave), tenantId, idDe('pessoa', p.chave),
        'phone', p.telefone, 'native', 'provado', instante(hoje, 90, '08:00'),
      ]),
    },
    {
      tabela: 'lead_manager.service_account',
      colunas: ['id', 'tenant_id', 'status', 'servico_label', 'plano_label', 'periodicidade',
        'ini_vigencia', 'fim_vigencia', 'status_renovacao', 'last_synced_at', 'fonte_ausente_em'],
      chaveConflito: ['id'],
      // fonte_ausente_em NULL é condição de TODA consulta de renovação (o contrato "existe na
      // fonte"). Preenchido, o contrato desaparece das telas sem erro nenhum.
      linhas: contratos.map((ct) => [
        idDe('contrato', ct.chave), tenantId, ct.status, ct.p.servico, ct.p.plano,
        ct.p.periodicidade, ct.ini, ct.fim, null, instante(hoje, 0, '04:00'), null,
      ]),
    },
    {
      tabela: 'lead_manager.account_member',
      colunas: ['id', 'tenant_id', 'account_id', 'person_id', 'bond'],
      chaveConflito: ['id'],
      linhas: contratos.flatMap((ct) => {
        const linhas = [[
          idDe('membro', `${ct.chave}|beneficiario`), tenantId,
          idDe('contrato', ct.chave), idDe('pessoa', ct.beneficiario), 'beneficiario',
        ]];
        // Pagador SEMPRE tem linha própria — inclusive quando é a mesma pessoa. A régua da
        // renovação resolve o pagador ANTES do beneficiário; sem a linha, ela cai no fallback e
        // o cenário deixaria de provar a precedência.
        linhas.push([
          idDe('membro', `${ct.chave}|pagador`), tenantId,
          idDe('contrato', ct.chave), idDe('pessoa', ct.pagador), 'pagador',
        ]);
        return linhas;
      }),
    },
    {
      tabela: 'lead_manager.conversations',
      colunas: ['id', 'tenant_id', 'channel', 'external_id', 'conversation_kind',
        'last_activity_at', 'last_read_at', 'updated_at', 'created_at'],
      chaveConflito: ['id'],
      // ⚠ `br_key` é coluna GENERATED (migr 112) — NÃO entra no INSERT; o banco a calcula de
      // external_id. É ela que casa conversa × contato do cadastro na aba Renovações.
      linhas: conversas,
    },
    {
      tabela: 'lead_manager.leads',
      colunas: ['id', 'tenant_id', 'name', 'phone', 'status', 'intent', 'origem',
        'desfecho', 'desfecho_notas', 'desfecho_em', 'aborda_renovacao', 'created_at', 'updated_at'],
      chaveConflito: ['id'],
      linhas: leads,
    },
    {
      tabela: 'lead_manager.messages',
      colunas: ['id', 'tenant_id', 'conversation_id', 'direction', 'role',
        'external_message_id', 'sender', 'body', 'media_type', 'media_transcription', 'received_at'],
      chaveConflito: ['id'],
      linhas: msgsCliente,
    },
    {
      tabela: 'lead_manager.staff_outbound_samples',
      colunas: ['id', 'tenant_id', 'channel', 'external_id', 'external_message_id',
        'source', 'sender', 'body', 'is_group', 'received_at'],
      chaveConflito: ['id'],
      linhas: saidasRecepcao,
    },
    {
      tabela: 'lead_manager.pending_approvals',
      colunas: ['id', 'tenant_id', 'lead_id', 'conversation_id', 'suggested_response', 'status', 'created_at'],
      chaveConflito: ['id'],
      linhas: sugestoesIa,
    },
    {
      tabela: 'lead_manager.renovacao_touchpoint',
      colunas: ['id', 'tenant_id', 'account_id', 'person_id', 'marco', 'fim_vigencia', 'due_date',
        'phone', 'destinatario_nome', 'aluno_nome', 'servico_label', 'estrategia', 'rascunho',
        'status', 'auto', 'enviado_em'],
      chaveConflito: ['id'],
      linhas: toques,
    },
  ];
}

/** 'YYYY-MM-DD' → 'DD/MM' (o rascunho fala com uma pessoa, não com um banco). PURA. */
function _dataBR(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return `${m[3]}/${m[2]}`;
}

/**
 * ⭐ A LISTA ÚNICA de tabelas a conferir — DERIVADA do plano, nunca escrita à mão.
 *
 * É a correção direta do que aconteceu em 31/10/2026 no dashboard: a gravação morreu na sexta de
 * oito tabelas com 22 testes verdes porque a lista de CHECKs conferidos tinha sido digitada
 * separadamente e esqueceu uma. Qualquer camada de conferência que precise saber "quais tabelas"
 * chama ISTO.
 */
function tabelasDoPlano(p) {
  if (!Array.isArray(p) || !p.length) throw new Error('cenario-mf8: plano vazio.');
  return [...new Set(p.map((x) => x.tabela))];
}

/** Resumo do cenário, para o log do seed e para o runbook. PURA. */
function resumo({ tenantId, hoje }) {
  const p = plano({ tenantId, hoje });
  const porTabela = Object.fromEntries(p.map((x) => [x.tabela, x.linhas.length]));
  return { tabelas: tabelasDoPlano(p).length, linhas: Object.values(porTabela).reduce((a, b) => a + b, 0), porTabela };
}

module.exports = {
  NAMESPACE, PLANOS, CONVERSAS, CONTRATOS_SEM_CONVERSA, FUSO, ANCORA_DA_APRESENTACAO,
  idDe, maisDias, instante, plano, tabelasDoPlano, resumo,
};
