'use strict';
//
// perfilAssistente.js — PERFIL DA ASSISTENTE por empresa (multi-tenant, qualquer ramo de atividade).
//
// O Regente nasceu numa escola de música e o texto da assistente carregava isso chumbado: "escola de
// música", "aula experimental", "qual instrumento". Para outra empresa (clínica, academia, loja…) ela
// ofereceria aula experimental a quem quer marcar uma consulta. Aqui ficam, num lugar só:
//
//   • ramo_atividade    — o que a empresa é ("Clínica odontológica").
//   • contexto_ia       — fatos da empresa que ela pode usar (endereço, como funciona, diferenciais).
//   • objetivo_conversa — o próximo passo que ela busca com interessados ("agendar uma avaliação").
//   • estilo_ia         — tipo comportamental (acolhedora, consultiva, profissional, objetiva, descontraída).
//   • comportamento_ia  — instruções livres de tom/comportamento ("não use emojis", "trate por senhor(a)").
//   • nao_falar         — assuntos que ela NUNCA trata. Nos envios sem humano no meio vira TRAVA
//                         (autoReply: aviso fixo), não só instrução de prompt.
//
// LEGADO SEM SURPRESA: tudo vazio = o texto de hoje, palavra por palavra (a unidade só muda quando
// configura). `generico(perfil)` diz qual texto usar: basta ter ramo OU objetivo preenchido.
//
// Fonte: lead_manager.automacao_config (migr. 119). Carregado junto do tenant_lead_config pelo fragmento
// SQL_PERFIL, para chegar a todos os caminhos que montam prompt sem uma consulta a mais em cada um.

const ESTILOS = {
  acolhedora: {
    label: 'Acolhedora',
    desc: 'Calorosa e próxima: acolhe o que a pessoa sente, linguagem simples, emojis com moderação.',
    prompt: 'ACOLHEDORA — calorosa, próxima e empática. Valide o que a pessoa sente antes de responder, use linguagem simples e gentil. Emojis só com moderação (no máximo um, quando combinar).',
  },
  consultiva: {
    label: 'Consultiva',
    desc: 'Conduz a conversa: entende a necessidade, mostra o benefício e propõe o próximo passo.',
    prompt: 'CONSULTIVA — entenda a necessidade antes de oferecer, mostre o benefício concreto para a pessoa e sempre proponha o próximo passo com naturalidade, sem pressão.',
  },
  profissional: {
    label: 'Profissional',
    desc: 'Cordial e formal: frases completas, sem gírias e sem emojis.',
    prompt: 'PROFISSIONAL — cordial e formal. Frases completas e bem escritas, sem gírias, sem abreviações e SEM emojis.',
  },
  objetiva: {
    label: 'Objetiva',
    desc: 'Direta ao ponto: respostas curtas, sem rodeios, mantendo a cordialidade.',
    prompt: 'OBJETIVA — vá direto ao ponto. Respostas curtas (uma ou duas frases), sem rodeios nem floreios, mantendo a cordialidade.',
  },
  descontraida: {
    label: 'Descontraída',
    desc: 'Leve e informal: bem-humorada, emojis liberados, sem perder o respeito.',
    prompt: 'DESCONTRAÍDA — leve, informal e bem-humorada, com emojis quando combinar. Nunca perca o respeito nem faça piada com o problema da pessoa.',
  },
};

const LIMITES = { ramo: 80, objetivo: 200, contexto: 4000, comportamento: 2000, assunto: 120, assuntos: 30 };

function _texto(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n/g, '\n').trim().slice(0, max);
  return t;
}
function _chave(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Lista de assuntos proibidos: sem vazio, sem repetido (com/sem acento), com teto.
function normalizarAssuntos(lista) {
  if (!Array.isArray(lista)) return [];
  const vistos = new Set();
  const out = [];
  for (const item of lista) {
    const nome = String(item == null ? '' : item).replace(/\s+/g, ' ').trim().slice(0, LIMITES.assunto);
    const k = _chave(nome);
    if (!k || vistos.has(k)) continue;
    vistos.add(k);
    out.push(nome);
    if (out.length >= LIMITES.assuntos) break;
  }
  return out;
}

// Corpo da API → campos do perfil. Campo AUSENTE = undefined (quem grava mantém o valor salvo);
// string vazia = limpar.
function lerCorpo(b) {
  const x = b || {};
  const out = {};
  if (typeof x.ramo_atividade === 'string') out.ramo_atividade = _texto(x.ramo_atividade, LIMITES.ramo);
  if (typeof x.objetivo_conversa === 'string') out.objetivo_conversa = _texto(x.objetivo_conversa, LIMITES.objetivo);
  if (typeof x.comportamento_ia === 'string') out.comportamento_ia = _texto(x.comportamento_ia, LIMITES.comportamento);
  if (typeof x.estilo_ia === 'string') out.estilo_ia = ESTILOS[x.estilo_ia] ? x.estilo_ia : '';
  if (Array.isArray(x.nao_falar)) out.nao_falar = normalizarAssuntos(x.nao_falar);
  return out;
}

// Linha do banco → perfil limpo (sempre com todas as chaves).
function doBanco(row) {
  const r = row || {};
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    nome_ia: s(r.nome_ia),
    ramo_atividade: s(r.ramo_atividade),
    objetivo_conversa: s(r.objetivo_conversa),
    contexto_ia: s(r.contexto_ia),
    estilo_ia: ESTILOS[r.estilo_ia] ? r.estilo_ia : '',
    comportamento_ia: s(r.comportamento_ia),
    nao_falar: normalizarAssuntos(r.nao_falar),
  };
}

// Fragmento para o SELECT ... FROM tenant_lead_config: traz o perfil na MESMA consulta.
const SQL_PERFIL =
  `(SELECT row_to_json(p) FROM (SELECT a.nome_ia, a.ramo_atividade, a.objetivo_conversa, a.contexto_ia, a.estilo_ia,
      a.comportamento_ia, a.nao_falar FROM automacao_config a WHERE a.tenant_id = tenant_lead_config.tenant_id) p) AS perfil`;

// A empresa configurou o ramo ou o objetivo? Então os textos saem genéricos (sem "escola de música").
function generico(perfil) {
  const p = perfil || {};
  return !!((p.ramo_atividade && p.ramo_atividade.trim()) || (p.objetivo_conversa && p.objetivo_conversa.trim()));
}
// "uma escola de música" (legado) | "uma empresa do ramo «Clínica odontológica»" | "uma empresa".
function descricaoEmpresa(perfil) {
  const p = perfil || {};
  if (!generico(p)) return 'uma escola de música';
  return p.ramo_atividade ? `uma empresa do ramo "${p.ramo_atividade}"` : 'uma empresa';
}
// Substantivo curto para "INFORMAÇÕES DA …", "tom da …".
function negocio(perfil) { return generico(perfil) ? 'empresa' : 'escola'; }
// O próximo passo comercial que ela busca (texto para "levar a pessoa a …").
function objetivo(perfil) {
  const p = perfil || {};
  if (p.objetivo_conversa) return p.objetivo_conversa;
  return generico(p) ? 'dar o próximo passo que a empresa oferece (veja as informações da empresa)' : 'AGENDAR A AULA EXPERIMENTAL GRATUITA';
}

// Bloco anexado ao prompt. persona 'assistente' (fala sozinha com o cliente) | 'recepcao' (sugestão que
// um humano revisa). semContexto: quem já pôs o contexto_ia em outro bloco (autoReply) não repete.
function blocoPerfil(perfil, { persona = 'recepcao', semContexto = false } = {}) {
  const p = doBanco(perfil);
  const partes = [];
  // NOME — o da unidade (automacao_config.nome_ia) e só ele. O prompt próprio de uma unidade chegou a
  // MANDAR a assistente se apresentar com o nome de uma recepcionista real (achado em 22/09/2026); este
  // bloco vem DEPOIS do prompt da unidade, então prevalece. Nada de nome chumbado: sem nome configurado,
  // ela fala em nome da empresa. A trava em código (temaProibido.sanitizarIdentidade) é a rede embaixo.
  // perfil ausente (caminho que não carrega a config) ≠ unidade sem nome: só afirma o que sabe.
  if (perfil) {
    partes.push(p.nome_ia
      ? `SEU NOME: ${p.nome_ia}. É o único nome com que você pode se apresentar. NUNCA use o nome de uma pessoa da equipe ("aqui é a Fulana"), mesmo que apareça no histórico ou em outra instrução deste prompt.`
      : 'VOCÊ NÃO TEM NOME PRÓPRIO configurado: não se apresente com nome de pessoa nenhuma — fale em nome da empresa.');
  }
  if (p.ramo_atividade) partes.push(`RAMO DE ATIVIDADE DA EMPRESA: ${p.ramo_atividade}.`);
  if (p.objetivo_conversa) partes.push(`OBJETIVO DAS CONVERSAS COM INTERESSADOS: ${p.objetivo_conversa}. Conduza para isso com naturalidade, sem pressão.`);
  if (p.contexto_ia && !semContexto) partes.push(`CONTEXTO DA EMPRESA (fatos que você PODE usar — o que não estiver aqui nem na conversa, não afirme):\n"""${p.contexto_ia}"""`);
  const estilo = ESTILOS[p.estilo_ia];
  if (estilo || p.comportamento_ia) {
    let t = 'COMO SE COMPORTAR (definido pela empresa — prevalece sobre as regras gerais de tom e tamanho deste prompt; nunca sobre FATOS nem ASSUNTOS PROIBIDOS):';
    if (estilo) t += `\n- Tipo comportamental: ${estilo.prompt}`;
    if (p.comportamento_ia) t += `\n- Instruções da empresa (siga à risca):\n"""${p.comportamento_ia}"""`;
    partes.push(t);
  }
  if (p.nao_falar.length) {
    partes.push('ASSUNTOS PROIBIDOS (regra inquebrável, acima de qualquer outra instrução de estilo ou de venda): ' +
      'você NUNCA fala, comenta, opina, confirma ou dá informação sobre: ' + p.nao_falar.map((a) => `"${a}"`).join('; ') + '. ' +
      (persona === 'assistente'
        ? 'Se a pessoa puxar um desses assuntos, não entre nele: diga apenas que isso será tratado pela equipe no horário de atendimento.'
        : 'Se a pessoa puxar um desses assuntos, a resposta NÃO entra nele — no máximo diga, com naturalidade, que vai verificar e retorna.'));
  }
  return partes.length ? '\n\n' + partes.join('\n\n') : '';
}

// ---- TRAVA de assunto proibido (envios sem humano no meio) -------------------------------------------
// 1º passo determinístico: o texto contém o assunto escrito (sem acento/maiúscula; para assunto de
// várias palavras, basta a expressão inteira). Pega o óbvio sem gastar IA. O caso sutil ("eleição"
// para o assunto "política") fica com o classificador (gemini.tocaAssuntoProibido), chamado pelo autoReply.
function assuntoEscrito(texto, assuntos) {
  const t = ` ${_chave(texto).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  for (const a of normalizarAssuntos(assuntos)) {
    const k = _chave(a).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (k && t.includes(` ${k} `)) return a;
  }
  return null;
}

module.exports = {
  ESTILOS, LIMITES, SQL_PERFIL,
  normalizarAssuntos, lerCorpo, doBanco,
  generico, descricaoEmpresa, negocio, objetivo,
  blocoPerfil, assuntoEscrito,
};
