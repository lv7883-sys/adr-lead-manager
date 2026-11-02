'use strict';
//
// leadManual.js — o lead que a RECEPÇÃO digita, em vez de o WhatsApp trazer. Decisão PURA.
//
// ─── POR QUE ISTO NÃO EXISTIA, E O QUE FALTAVA ───────────────────────────────────────────────
//
// Medido em 02/11/2026: TODOS os caminhos que criam lead partem de uma conversa.
//
//   engine.js (6 pontos) ....... mensagem recebida, classificada pela IA
//   inbox/marcar-lead .......... a recepção marca uma conversa EXISTENTE como lead
//   unclassified/promote ....... promove o que a IA deixou de fora
//   sync-extranet-leads ........ espelho do sistema da franqueadora
//   bola/decisions ............. reversão de um veredito
//
// Nenhum deles aceita "fulana me ligou, o telefone é esse". E o contorno aparente — `inbox/iniciar`
// — exige um TEXTO e **envia um WhatsApp de verdade**; numa unidade sem credencial ele devolve
// `tenant_sem_evolution` e nem isso acontece. Ou seja: anotar alguém que ligou, ou que apareceu na
// porta, era impossível sem mandar mensagem para a pessoa.
//
// ─── AS TRÊS DECISÕES QUE ESTE ARQUIVO EXISTE PARA NÃO DEIXAR ERRAR ──────────────────────────
//
//   1. NÃO ENVIA NADA. Criar um lead é um registro interno. A diferença entre "anotei o contato"
//      e "mandei mensagem para o contato" é a diferença entre uma ficha e uma abordagem — e quem
//      digita um telefone na recepção não está pedindo para falar com a pessoa.
//
//   2. TELEFONE DUPLICADO NÃO CRIA UM SEGUNDO LEAD. `leads` usa telefone como identidade e o
//      casamento conversa×lead pega o lead MAIS ANTIGO daquele telefone (leadk, routes/inbox.js).
//      Um segundo lead do mesmo número seria INVISÍVEL: existiria na tabela, não apareceria na
//      conversa, e as contagens discordariam da tela sem erro nenhum. Então o caminho devolve o
//      lead que já existe, com `criado: false`, em vez de duplicar.
//      ⚠ Isto é um remendo numa contradição mais funda, já registrada: pessoa não é telefone, e
//      há linhas com duas pessoas no mesmo número. Este arquivo não conserta isso — só evita
//      piorar.
//
//   3. `origem = 'manual'`, e ela é o PRIMEIRO TOQUE. A migr 043 travou a decisão: origem é
//      gravada uma vez na criação e NUNCA alterada. Se a pessoa escrever pelo WhatsApp depois, a
//      origem continua 'manual' — porque o primeiro toque foi a recepção digitando, e é isso que
//      a métrica de fonte precisa saber. 'manual' já é valor reconhecido em
//      `origem_lead.metodo` (CHECK da migr 171).
//
const { digitsBR } = require('./telefoneBR');

// Limites. Não são estéticos: `name` é NOT NULL em `leads` (migr 001) e aparece na tela e em
// mensagem; telefone curto demais nunca casaria com conversa nenhuma.
const MAX_NOME = 120;
const MIN_DIGITOS = 8;    // mesma régua de `inbox/iniciar`
const MAX_DIGITOS = 15;   // E.164: nenhum telefone do mundo passa disso
const ORIGEM_PADRAO = 'manual';
// Origens que a recepção pode declarar ao anotar o contato. Lista curta e fechada de propósito:
// origem é a chave do recorte de FONTE nas métricas, e texto livre aqui viraria pó de categoria.
// (Medido em produção em 02/11/2026, os valores existentes eram: whatsapp 396, extranet 74,
// indicacao 2, site 1, e 501 nulos — o nulo é o legado de antes da migr 043.)
const ORIGENS_ACEITAS = Object.freeze(['manual', 'indicacao', 'telefone', 'presencial', 'site']);

const _texto = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/**
 * Prepara o lead que a recepção digitou. PURA — não toca banco, não envia nada.
 *
 * @param {{nome?: string, telefone?: string, origem?: string}} entrada
 * @returns {{ok: true, lead: {name: string, phone: string, status: string, origem: string}}
 *          |{ok: false, erro: string, detalhe: string}}
 */
function prepararLeadManual(entradaCrua) {
  // `= {}` no parâmetro só cobre `undefined`. O corpo de um POST pode chegar como `null` literal
  // ou como string, e aí o acesso a `.nome` LANÇA — a rota devolveria 500 ("erro interno") para o
  // que é, na verdade, uma requisição malformada do cliente. Recusa é a resposta certa, 400 é o
  // código certo, e explodir não é nenhum dos dois. Achado pelo teste, não imaginado.
  const entrada = (entradaCrua && typeof entradaCrua === 'object') ? entradaCrua : {};
  const nome = _texto(entrada.nome).slice(0, MAX_NOME);
  if (!nome) {
    return { ok: false, erro: 'nome_obrigatorio', detalhe: 'O lead precisa de um nome — a coluna é NOT NULL e é o que aparece no card.' };
  }

  const digitos = String(entrada.telefone == null ? '' : entrada.telefone).replace(/\D/g, '');
  if (digitos.length < MIN_DIGITOS) {
    return { ok: false, erro: 'telefone_invalido', detalhe: `Telefone com ${digitos.length} dígitos; o mínimo é ${MIN_DIGITOS}.` };
  }
  if (digitos.length > MAX_DIGITOS) {
    // Um número com mais de 15 dígitos não é telefone — costuma ser id de grupo do WhatsApp
    // (@g.us) ou @lid colado por engano. Recusar aqui evita um lead que nunca casa com ninguém.
    return { ok: false, erro: 'telefone_invalido', detalhe: `Telefone com ${digitos.length} dígitos; o máximo (E.164) é ${MAX_DIGITOS}.` };
  }

  // `digitsBR` é a MESMA normalização que o resto do sistema usa (src/telefoneBR.js) — não uma
  // segunda régua. O casamento conversa×lead compara dígitos crus dos dois lados, então guardar
  // no formato do webhook ("55…", sem o "+") é o que faz a conversa encontrar este lead quando
  // a pessoa finalmente escrever.
  const phone = digitsBR(digitos);
  if (!phone) {
    return { ok: false, erro: 'telefone_invalido', detalhe: 'Não foi possível normalizar o telefone.' };
  }

  const origemPedida = _texto(entrada.origem).toLowerCase();
  if (origemPedida && !ORIGENS_ACEITAS.includes(origemPedida)) {
    return {
      ok: false,
      erro: 'origem_invalida',
      detalhe: `Origem ${JSON.stringify(origemPedida)} não é aceita. Use uma de: ${ORIGENS_ACEITAS.join(', ')}.`,
    };
  }

  return {
    ok: true,
    lead: {
      name: nome,
      phone,
      // 'NEW' = a coluna "Novo" do kanban, que a régua marca como `auto: true` (intake: origem de
      // tudo, nunca destino de arraste). É onde um contato recém-anotado pertence.
      status: 'NEW',
      origem: origemPedida || ORIGEM_PADRAO,
    },
  };
}

module.exports = {
  prepararLeadManual,
  ORIGENS_ACEITAS, ORIGEM_PADRAO, MAX_NOME, MIN_DIGITOS, MAX_DIGITOS,
};
