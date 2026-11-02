'use strict';
//
// stagesUi.js — as COLUNAS do kanban COMO A UNIDADE QUER VER. Decisão PURA, sem banco.
//
// Renomear, esconder e acrescentar coluna. Pedido do Leo em 02/11/2026, reafirmado depois de eu
// recomendar o contrário — o que mudou a pergunta de "vale a pena?" para "como fazer sem quebrar".
//
// ─── A REGRA QUE SEPARA O BARATO DO PERIGOSO ─────────────────────────────────────────────────
//
// Coluna extra é VISTA, não ESTADO. O `status` do lead não muda quando ele entra numa coluna
// criada pela unidade; muda só onde o card aparece (`leads.etapa_custom`, migr 188). Então o
// funil, o BI e as taxas de conversão seguem medindo as mesmas cinco etapas e continuam
// comparáveis entre unidades.
//
// A medição que tornou isso obrigatório está no cabeçalho da migr 188: a partição canônica
// termina com `ELSE 'qualificando'` nas duas pontas, então um status desconhecido cairia em
// "Qualificando" POR ELIMINAÇÃO — o lead apareceria na coluna extra E seria contado como
// qualificando em todo o resto, sem erro nenhum.
//
// ─── AS QUATRO RECUSAS, E O QUE CADA UMA EVITA ───────────────────────────────────────────────
//
//   1. Chave de coluna extra TEM de começar com `x_`. Sem isso, uma unidade poderia criar uma
//      coluna chamada `convertido` e o quadro passaria a ter duas com a mesma chave — a segunda
//      recebendo cards que o resto do sistema procura na primeira.
//   2. NÃO dá para esconder a coluna de entrada (`novo`). Lead novo cai nela sozinho; escondê-la
//      faria todo lead que chega ficar INVISÍVEL, sem erro e sem aviso.
//   3. NÃO dá para esconder uma coluna que tenha card dentro — quem chama informa a contagem.
//      Esconder coluna cheia é esconder lead, e lead escondido é lead perdido.
//   4. Teto de colunas extras. Um quadro com quinze colunas não é um quadro.
//
// Nada disto é opinião sobre gosto: cada recusa existe porque a alternativa some com informação
// em silêncio, que é o modo de falha que este projeto mais paga.
//
const MAX_EXTRAS = 4;
const MAX_LABEL = 28;        // cabe no cabeçalho da coluna sem quebrar o layout
const MAX_DICA = 80;
const MAX_DEFINICAO = 300;   // condição para a IA; cabe numa frase longa, não num manual
const PREFIXO_EXTRA = 'x_';
// A coluna de ENTRADA não pode sumir. `novo` é marcada `auto: true` na régua canônica: é origem
// de tudo e nunca destino de arraste — é nela que um lead recém-criado nasce.
const NAO_OCULTAVEIS = Object.freeze(['novo']);

const _texto = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Erro de configuração, com código — quem chama distingue sem ler a mensagem. */
function _recusa(codigo, mensagem) {
  return { ok: false, erro: codigo, detalhe: mensagem };
}

/**
 * Valida e normaliza a configuração de colunas de uma unidade. PURA.
 *
 * @param {object} bruta        o que veio da tela / do banco (`tenant_lead_config.stage_ui`)
 * @param {string[]} chavesCanonicas  as chaves da régua (stages.KANBAN_KEYS)
 * @param {Record<string,number>} [cardsPorColuna]  quantos cards há hoje em cada chave — usado
 *        só para a recusa 3 (esconder coluna cheia). Ausente = a recusa 3 não é aplicada, e isso
 *        está DITO: quem valida sem a contagem não está conferindo essa regra.
 */
function validarConfig(bruta, chavesCanonicas, cardsPorColuna) {
  if (!Array.isArray(chavesCanonicas) || !chavesCanonicas.length) {
    throw new Error('stagesUi: chavesCanonicas é obrigatório — sem a régua não há o que validar contra.');
  }
  const c = (bruta && typeof bruta === 'object' && !Array.isArray(bruta)) ? bruta : {};
  const canon = new Set(chavesCanonicas);

  // ---- extras ----
  const extrasBrutos = Array.isArray(c.extras) ? c.extras : [];
  if (extrasBrutos.length > MAX_EXTRAS) {
    return _recusa('extras_demais', `${extrasBrutos.length} colunas extras; o máximo é ${MAX_EXTRAS}.`);
  }
  const extras = [];
  const vistas = new Set();
  for (const e of extrasBrutos) {
    const o = (e && typeof e === 'object') ? e : {};
    const key = _texto(o.key, 40).toLowerCase().replace(/\s/g, '');
    if (!key.startsWith(PREFIXO_EXTRA) || key.length <= PREFIXO_EXTRA.length) {
      return _recusa('chave_invalida',
        `A chave ${JSON.stringify(key)} precisa começar com ${JSON.stringify(PREFIXO_EXTRA)} — é o que impede uma coluna criada aqui de colidir com uma da régua.`);
    }
    if (!/^x_[a-z0-9_]+$/.test(key)) {
      return _recusa('chave_invalida', `A chave ${JSON.stringify(key)} só pode ter letras sem acento, números e _.`);
    }
    if (canon.has(key)) return _recusa('chave_invalida', `${JSON.stringify(key)} é uma chave da régua.`);
    if (vistas.has(key)) return _recusa('chave_repetida', `A chave ${JSON.stringify(key)} aparece duas vezes.`);
    vistas.add(key);

    const label = _texto(o.label, MAX_LABEL);
    if (!label) return _recusa('label_obrigatorio', `A coluna ${JSON.stringify(key)} precisa de um nome.`);

    const depois = _texto(o.depois, 40);
    if (depois && !canon.has(depois) && !vistas.has(depois)) {
      return _recusa('posicao_invalida',
        `A coluna ${JSON.stringify(key)} pede para vir depois de ${JSON.stringify(depois)}, que não existe.`);
    }
    // `definicao` é OUTRA coisa que `dica`, e confundir as duas seria caro:
    //   dica      → texto para o HUMANO, aparece embaixo do título da coluna
    //   definicao → CONDIÇÃO para a IA: "o que tem de acontecer na conversa para o lead estar
    //               aqui". Vai para o prompt do classificador, ao lado das etapas canônicas
    //               (tenant_lead_config.stage_definitions). Sem ela, a IA nunca sugere esta
    //               coluna — e isso é o default, porque sugerir sem condição é adivinhar.
    extras.push({
      key, label,
      emoji: _texto(o.emoji, 8) || '•',
      dica: _texto(o.dica, MAX_DICA) || null,
      definicao: _texto(o.definicao, MAX_DEFINICAO) || null,
      depois: depois || null,
    });
  }

  // ---- ocultas ----
  const ocultasBrutas = Array.isArray(c.ocultas) ? c.ocultas : [];
  const ocultas = [];
  for (const k of ocultasBrutas) {
    const key = _texto(k, 40);
    if (!canon.has(key) && !vistas.has(key)) {
      return _recusa('coluna_inexistente', `Não dá para esconder ${JSON.stringify(key)}: essa coluna não existe.`);
    }
    if (NAO_OCULTAVEIS.includes(key)) {
      return _recusa('coluna_obrigatoria',
        `A coluna ${JSON.stringify(key)} é onde todo lead novo nasce. Escondê-la faria cada lead que chega ficar invisível.`);
    }
    if (cardsPorColuna && Number(cardsPorColuna[key] || 0) > 0) {
      return _recusa('coluna_com_card',
        `A coluna ${JSON.stringify(key)} tem ${cardsPorColuna[key]} card(s). Esconder agora esconderia esses leads — mova-os antes.`);
    }
    if (!ocultas.includes(key)) ocultas.push(key);
  }
  if (ocultas.length >= chavesCanonicas.length + extras.length) {
    return _recusa('quadro_vazio', 'Isso esconderia todas as colunas.');
  }

  // ---- rótulos ----
  const rotulosBrutos = (c.rotulos && typeof c.rotulos === 'object') ? c.rotulos : {};
  const rotulos = {};
  for (const [k, v] of Object.entries(rotulosBrutos)) {
    const key = _texto(k, 40);
    if (!canon.has(key) && !vistas.has(key)) {
      return _recusa('coluna_inexistente', `Não dá para renomear ${JSON.stringify(key)}: essa coluna não existe.`);
    }
    const o = (v && typeof v === 'object') ? v : {};
    const r = {};
    const label = _texto(o.label, MAX_LABEL);
    if (label) r.label = label;
    const emoji = _texto(o.emoji, 8);
    if (emoji) r.emoji = emoji;
    // `dica: ''` é intencional: apaga a dica. Por isso o teste é por PRESENÇA da chave, não por
    // valor verdadeiro — senão não haveria como limpar uma dica herdada da régua.
    if (Object.prototype.hasOwnProperty.call(o, 'dica')) r.dica = _texto(o.dica, MAX_DICA) || null;
    if (Object.keys(r).length) rotulos[key] = r;
  }

  return { ok: true, config: { rotulos, ocultas, extras } };
}

/**
 * Aplica a configuração sobre as colunas canônicas e devolve a lista a desenhar. PURA.
 *
 * @param {Array<{key,status,emoji,label,dica,auto,requerMotivo}>} canonicas  já resolvidas por ramo
 * @param {{rotulos,ocultas,extras}} config  saída de validarConfig (ou {} para "nada configurado")
 */
function aplicarConfig(canonicas, config) {
  const cfg = (config && typeof config === 'object') ? config : {};
  const rotulos = cfg.rotulos || {};
  const ocultas = new Set(Array.isArray(cfg.ocultas) ? cfg.ocultas : []);
  const extras = Array.isArray(cfg.extras) ? cfg.extras : [];

  const comRotulo = (col) => {
    const r = rotulos[col.key];
    if (!r) return col;
    return {
      ...col,
      label: r.label || col.label,
      emoji: r.emoji || col.emoji,
      dica: Object.prototype.hasOwnProperty.call(r, 'dica') ? r.dica : col.dica,
    };
  };

  // Começa pelas canônicas, na ordem da régua, já renomeadas e sem as escondidas.
  const fora = canonicas.filter((c) => !ocultas.has(c.key)).map(comRotulo);

  // Encaixa cada extra DEPOIS da coluna pedida; sem posição válida, vai para o fim. Uma coluna
  // extra nunca tem `status` (não é estado) nem `requerMotivo`, e nunca é `auto` (lead novo não
  // nasce numa coluna criada pela unidade).
  for (const e of extras) {
    if (ocultas.has(e.key)) continue;
    const col = comRotulo({
      key: e.key, status: null, emoji: e.emoji, label: e.label, dica: e.dica,
      auto: false, requerMotivo: false, extra: true,
    });
    const i = e.depois ? fora.findIndex((x) => x.key === e.depois) : -1;
    if (i >= 0) fora.splice(i + 1, 0, col); else fora.push(col);
  }
  return fora;
}

/**
 * ⭐ As etapas que a IA pode SUGERIR, depois da configuração da unidade. PURA.
 *
 * Pedido do Leo em 02/11/2026: a edição de colunas tem de se refletir "também na classificação
 * de leads". Isto é o elo — e ele existe porque a classificação JÁ é configurável por unidade:
 * `tenant_lead_config.stage_definitions` é um mapa `{chave: condição}` que vira bloco de prompt
 * em `gemini._stageBlock`, e a saída da IA é validada contra essas chaves. Não havia régua nova
 * a inventar; havia uma régua a LIGAR na outra.
 *
 * As duas coisas que mudam, e cada uma conserta uma incoerência de verdade:
 *
 *   1. COLUNA ESCONDIDA SAI DA LISTA. Sem isso, a IA sugeriria mover um lead para uma coluna
 *      que a unidade escondeu — o chip "IA sugere → X" apontando para um lugar que não está na
 *      tela, e o botão de confirmar movendo o card para fora da vista.
 *   2. COLUNA CRIADA ENTRA, se tiver `definicao`. Sem `definicao` ela NÃO entra, e isso é
 *      decisão: sugerir etapa sem condição escrita é adivinhar, e a saída seria um chip que
 *      ninguém sabe justificar.
 *
 * ⚠ E o que NÃO muda: o rótulo. A IA raciocina sobre a CHAVE e a CONDIÇÃO, nunca sobre o nome
 * que a unidade deu à coluna. Renomear uma coluna não pode mudar o que a IA decide — senão a
 * classificação passaria a depender de texto de interface, e duas unidades com a mesma régua e
 * nomes diferentes classificariam diferente.
 *
 * @param {object|null} stageDefinitions  `tenant_lead_config.stage_definitions` ({chave: texto})
 * @param {object|null} config            saída de validarConfig
 * @returns {object|null}  o mapa para o prompt, ou null quando não há nada sugerível (o que
 *                         DESLIGA o recurso, que é o comportamento de hoje para quem não tem defs)
 */
function definicoesParaIA(stageDefinitions, config) {
  const base = (stageDefinitions && typeof stageDefinitions === 'object' && !Array.isArray(stageDefinitions))
    ? stageDefinitions : {};
  const cfg = (config && typeof config === 'object') ? config : {};
  const ocultas = new Set(Array.isArray(cfg.ocultas) ? cfg.ocultas : []);
  const extras = Array.isArray(cfg.extras) ? cfg.extras : [];

  const fora = {};
  for (const [k, v] of Object.entries(base)) {
    if (ocultas.has(k)) continue;                                   // (1)
    if (typeof v === 'string' && v.trim()) fora[k] = v;
  }
  for (const e of extras) {                                          // (2)
    if (!e || ocultas.has(e.key)) continue;
    if (typeof e.definicao === 'string' && e.definicao.trim()) fora[e.key] = e.definicao;
  }
  return Object.keys(fora).length ? fora : null;
}

/**
 * ⭐ A ETAPA EM QUE O CARD APARECE, para QUALQUER aba. PURA, e é FONTE ÚNICA.
 *
 * Pedido do Leo em 02/11/2026: a configuração de colunas tem de se refletir em todas as abas.
 * O jeito errado de atender seria repetir `l.etapa_custom || stageKey(...)` em cada lugar que
 * mostra etapa — e este projeto já pagou por réguas copiadas em quatro, cinco e sete lugares
 * (o nome do contato, a bola, a chave de tenant). Então a régua nasce uma vez, aqui.
 *
 * ⚠ E ela cai para a canônica quando a coluna extra NÃO EXISTE MAIS na configuração — unidade
 * que apagou a coluna não pode deixar card apontando para o vazio. Falha fechada: o lead
 * reaparece onde sempre esteve, em vez de sumir da aba.
 *
 * @param {{status?, desfecho?, etapa_custom?}} lead
 * @param {object|null} config  saída de validarConfig
 * @param {(status, desfecho) => string} stageKey  a partição canônica (stages.stageKey)
 */
function etapaDoLead(lead, config, stageKey) {
  if (typeof stageKey !== 'function') {
    throw new Error('stagesUi.etapaDoLead: stageKey é obrigatório — a partição canônica não se reimplementa aqui.');
  }
  const l = lead || {};
  const custom = typeof l.etapa_custom === 'string' ? l.etapa_custom.trim() : '';
  if (custom) {
    const cfg = (config && typeof config === 'object') ? config : {};
    const extras = Array.isArray(cfg.extras) ? cfg.extras : [];
    const ocultas = new Set(Array.isArray(cfg.ocultas) ? cfg.ocultas : []);
    if (extras.some((e) => e && e.key === custom) && !ocultas.has(custom)) return custom;
  }
  return stageKey(l.status, l.desfecho);
}

module.exports = {
  validarConfig, aplicarConfig, definicoesParaIA, etapaDoLead,
  MAX_EXTRAS, MAX_LABEL, MAX_DICA, MAX_DEFINICAO, PREFIXO_EXTRA, NAO_OCULTAVEIS,
};
