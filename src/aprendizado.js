'use strict';
//
// aprendizado.js — A IA PROPÔS ISTO; A RECEPÇÃO ENVIOU AQUILO. O QUE ISSO ENSINA?
//
// O objetivo do Leo é, um dia, ligar a resposta automática aos leads. Em 22/09/2026 ficou medido
// que não havia evidência nenhuma para decidir isso: o botão "Sugerir" da Caixa de Entrada gerava
// o texto e não registrava nada — nem que foi pedido, nem o que foi enviado no lugar.
//
// A migração 176 passou a guardar o FATO (o que a IA propôs). Este arquivo responde a pergunta,
// e ele é o ÚNICO lugar onde a comparação mora. Isso é deliberado: em 22-23/09 encontramos a mesma
// pergunta respondida em cinco lugares diferentes ("de quem é a bola"), cada um com o seu jeito, e
// o dia inteiro foi gasto desfazendo isso. Aqui a régua nasce única.
//
// A ESCOLHA DE DESENHO: o veredito NÃO é gravado. Ele é derivado na leitura, comparando a sugestão
// com a saída real que veio depois. Assim a régua pode melhorar (limiar, normalização) e o passado
// inteiro é reavaliado junto — em vez de ficar uma coluna com o veredito velho de uma régua antiga.
//
// OS QUATRO DESFECHOS, e o que cada um ensina:
//   enviou_igual     — a IA acertou sozinha. É o candidato natural do modo automático.
//   editou           — a IA acertou o rumo e errou detalhes. É o material mais rico p/ melhorar o
//                      prompt: o par (o que ela escreveu, o que a recepção corrigiu).
//   escreveu_do_zero — a IA não serviu. Se concentrar num tipo de pergunta, é lá que ela não sabe.
//   nao_respondeu    — ninguém respondeu no prazo. NÃO é nota da IA (não diz nada sobre o texto);
//                      é um fato sobre o atendimento, e por isso fica fora das taxas de acerto.
//
// ⚠ O QUE ESTE NÚMERO NÃO É: não é "a IA está pronta". Mede concordância com o que a recepção
// escreveu, não se a resposta trouxe matrícula. Uma recepcionista com pressa que envia igual não
// prova qualidade; prova conveniência. Ler junto do funil, nunca sozinho.

// Limiares. Explicitados aqui porque são a única parte arbitrária da régua — e a que vai mudar
// quando houver amostra suficiente para calibrar.
const IGUAL_MIN = 0.95;     // praticamente o mesmo texto (diferença de pontuação/espaço)
const EDITOU_MIN = 0.50;    // reconhecível como a sugestão, com mexidas
const JANELA_PADRAO_H = 24; // depois disso, a saída não é mais "resposta àquela sugestão"

const ENVIOU_IGUAL = 'enviou_igual';
const EDITOU = 'editou';
const ESCREVEU_DO_ZERO = 'escreveu_do_zero';
const NAO_RESPONDEU = 'nao_respondeu';

// Normalização para comparar: o que muda aqui muda a taxa, então está num lugar só e explicado.
// Tira acento, caixa, pontuação e espaço repetido — porque "Olá, tudo bem?" e "ola tudo bem"
// são a MESMA resposta para efeito de "a IA acertou". Não tira emoji: trocar 🙂 por nada é edição
// de tom, e tom é justamente o que a unidade configura no perfil da assistente.
function normalizar(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[.,;:!?()\[\]{}"'`´–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Similaridade por BIGRAMAS de caractere (coeficiente de Sørensen–Dice).
// Escolhido em vez de distância de edição porque é estável com frase reordenada — a recepcionista
// que troca a ordem de duas frases não "escreveu do zero", e a distância de edição diria que sim.
function similaridade(a, b) {
  const x = normalizar(a);
  const y = normalizar(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const pares = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const p = s.slice(i, i + 2);
      m.set(p, (m.get(p) || 0) + 1);
    }
    return m;
  };
  const ma = pares(x), mb = pares(y);
  let comuns = 0, totalA = 0, totalB = 0;
  for (const [, n] of ma) totalA += n;
  for (const [p, n] of mb) {
    totalB += n;
    const na = ma.get(p);
    if (na) comuns += Math.min(na, n);
  }
  return (2 * comuns) / (totalA + totalB);
}

/**
 * O desfecho de UMA sugestão, dada a saída real que veio depois (ou a ausência dela).
 * @param {string} sugerido  texto que a IA propôs
 * @param {string|null} enviado  texto realmente enviado ao contato depois (null = nada saiu)
 * @returns {{desfecho: string, similaridade: number|null}}
 */
function desfechoDaSugestao(sugerido, enviado) {
  if (enviado == null || !String(enviado).trim()) return { desfecho: NAO_RESPONDEU, similaridade: null };
  const sim = similaridade(sugerido, enviado);
  const desfecho = sim >= IGUAL_MIN ? ENVIOU_IGUAL
    : sim >= EDITOU_MIN ? EDITOU
      : ESCREVEU_DO_ZERO;
  return { desfecho, similaridade: Math.round(sim * 1000) / 1000 };
}

/**
 * Consulta que casa cada sugestão com a PRIMEIRA saída nossa para aquele contato depois dela,
 * dentro da janela. Devolve as linhas cruas; o veredito sai do desfechoDaSugestao (JS), para a
 * régua não existir em dois dialetos — a lição de `bola.js`, aplicada desde o primeiro dia aqui.
 *
 * O contato é casado por DÍGITOS do external_id da conversa, o mesmo casamento do resto do LM.
 */
function sqlSugestoesComResposta({ janelaHoras = JANELA_PADRAO_H } = {}) {
  return `
    SELECT s.id, s.criada_em, s.origem, s.contexto, s.pedida_por, s.texto AS sugerido,
           s.lead_id, s.conversation_id,
           (SELECT so.body FROM staff_outbound_samples so
             WHERE so.tenant_id = s.tenant_id
               AND regexp_replace(so.external_id, '[^0-9]', '', 'g')
                   = regexp_replace(cv.external_id, '[^0-9]', '', 'g')
               AND so.received_at >  s.criada_em
               AND so.received_at <= s.criada_em + make_interval(hours => ${Number(janelaHoras)})
               AND coalesce(so.body, '') <> ''
             ORDER BY so.received_at ASC LIMIT 1) AS enviado
      FROM lead_manager.sugestao_ia s
      LEFT JOIN lead_manager.conversations cv ON cv.id = s.conversation_id
     WHERE s.tenant_id = $1 AND s.criada_em >= now() - make_interval(days => $2::int)
     ORDER BY s.criada_em DESC`;
}

/**
 * Relatório pronto para tela/log. `linhas` são as devolvidas por sqlSugestoesComResposta.
 * Percentuais SEMPRE sobre o universo de sugestões que TIVERAM resposta — quem não respondeu não
 * é nota da IA, e incluí-lo no denominador faria a taxa de acerto cair por motivo alheio ao texto.
 * O total sem resposta vai junto, separado, porque também é informação (só que sobre atendimento).
 */
function relatorio(linhas) {
  const out = {
    total: 0,
    com_resposta: 0,
    [ENVIOU_IGUAL]: 0,
    [EDITOU]: 0,
    [ESCREVEU_DO_ZERO]: 0,
    [NAO_RESPONDEU]: 0,
    por_contexto: {},
    aproveitamento_pct: null,   // (enviou_igual + editou) / com_resposta
    igual_pct: null,            // enviou_igual / com_resposta — o candidato ao modo automático
  };
  for (const l of linhas || []) {
    const { desfecho } = desfechoDaSugestao(l.sugerido, l.enviado);
    out.total++;
    out[desfecho]++;
    if (desfecho !== NAO_RESPONDEU) out.com_resposta++;
    const ctx = l.contexto || l.origem || 'sem_contexto';
    const c = out.por_contexto[ctx] || (out.por_contexto[ctx] = {
      total: 0, [ENVIOU_IGUAL]: 0, [EDITOU]: 0, [ESCREVEU_DO_ZERO]: 0, [NAO_RESPONDEU]: 0,
    });
    c.total++; c[desfecho]++;
  }
  if (out.com_resposta > 0) {
    const pct = (n) => Math.round((n / out.com_resposta) * 1000) / 10;
    out.aproveitamento_pct = pct(out[ENVIOU_IGUAL] + out[EDITOU]);
    out.igual_pct = pct(out[ENVIOU_IGUAL]);
  }
  return out;
}

module.exports = {
  ENVIOU_IGUAL, EDITOU, ESCREVEU_DO_ZERO, NAO_RESPONDEU,
  IGUAL_MIN, EDITOU_MIN, JANELA_PADRAO_H,
  normalizar, similaridade, desfechoDaSugestao, sqlSugestoesComResposta, relatorio,
};
