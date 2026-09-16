'use strict';
//
// boasVindasRegua.js — ADR-050 (E17-01). O CÉREBRO da régua de boas-vindas: validação da régua da
// unidade, cálculo de quando cada mensagem sai e as travas R1–R10. PURO: sem banco, sem rede, sem
// relógio implícito (o "agora" sempre vem por parâmetro). O job (E17-02) e a tela (E17-04) só chamam
// estas funções.
//
// MULTI-RAMO: nada aqui sabe o que é "aula", "professor" ou "instrumento". O motor fala de
// início do contrato, atendimento agendado e primeiro atendimento; cada ramo dá os nomes dele.
//
// FUSO: São Paulo como UTC-3 fixo — a MESMA convenção de src/horario.js (fonte única do expediente),
// cuja normalização é reusada aqui. Este módulo não altera o horario.js.
//
const horario = require('./horario');

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Catálogo e limites (fonte única — a tela e o job leem daqui)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const ANCORAS = Object.freeze(['inicio_contrato', 'atendimento_agendado', 'primeiro_atendimento']);
const TIPOS_QUANDO = Object.freeze(['dias', 'vespera', 'proximo_expediente']);

const LIMITES = Object.freeze({
  PRIMEIRA_MAX_DIAS: 2,        // R1
  TETO_DIAS: 60,               // R2 — teto absoluto a partir do início do contrato
  FRACAO_VIGENCIA: 0.5,        // R2 — nunca depois da metade do contrato
  ESPACO_MIN_HORAS: 48,        // R3
  MIN_ETAPAS: 2,               // R4
  MAX_ETAPAS: 10,              // R4
  OFFSET_MAX_DIAS: 60,         // "dias" nunca passa do teto absoluto
  MAX_REPETICOES: 3,
  GRACE_DIAS: 7,               // R6
  CONTRATO_CURTO_DIAS: 45,     // contrato de até 45 dias = "mensal" da Academia do Rock
  ALERTA_MIN: 7,
  ALERTA_MAX: 30,
  ALERTA_PADRAO: 21,
  VESPERA_PREFERIDA_MIN: 18 * 60,   // véspera: fim do expediente, âncora 18:00
  VESPERA_MAX_DIAS_ATRAS: 3,        // véspera num dia fechado recua até 3 dias
  BUSCA_EXPEDIENTE_DIAS: 14,        // procura horário aberto por no máximo 14 dias
});

// Variáveis que o sistema preenche. As de FATO (R8) bloqueiam a mensagem quando faltam.
const VARIAVEIS_SISTEMA = Object.freeze(['cliente', 'responsavel', 'empresa', 'servico', 'profissional', 'dia', 'horario']);
const VARIAVEIS_FATO = Object.freeze(['dia', 'horario', 'profissional']);
const BLOQUEIO_POR_FATO = Object.freeze({ dia: 'sem_horario', horario: 'sem_horario', profissional: 'sem_profissional' });

// R10 — limites do WhatsApp por tipo de anexo.
const MB = 1024 * 1024;
const ANEXO = Object.freeze({
  imagem: { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * MB, legenda: true },
  video: { mimes: ['video/mp4'], maxBytes: 16 * MB, legenda: true },
  audio: { mimes: ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac'], maxBytes: 16 * MB, legenda: false },
  documento: { mimes: null, maxBytes: 100 * MB, legenda: true },   // qualquer formato
});
const LIMITE_LEGENDA = 1024;   // texto maior sai em mensagem separada, logo depois do arquivo

const DIA_MS = 86400000;
const SP_OFFSET_MS = 3 * 3600 * 1000;
const NOMES_DIA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Datas no fuso de São Paulo
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const ISO_DATA = /^\d{4}-\d{2}-\d{2}$/;

// 'YYYY-MM-DD' (dia civil em SP) → epoch ms de 00:00 SP daquele dia.
function inicioDoDiaSP(dataISO) {
  if (!ISO_DATA.test(String(dataISO))) throw new Error(`data inválida: ${dataISO}`);
  return Date.parse(`${dataISO}T00:00:00Z`) + SP_OFFSET_MS;
}
// epoch ms → 'YYYY-MM-DD' do dia civil em SP.
function dataSP(ms) {
  return new Date(ms - SP_OFFSET_MS).toISOString().slice(0, 10);
}
function somarDias(dataISO, n) {
  return new Date(Date.parse(`${dataISO}T00:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);
}
function diasEntre(aISO, bISO) {
  return Math.round((Date.parse(`${bISO}T00:00:00Z`) - Date.parse(`${aISO}T00:00:00Z`)) / DIA_MS);
}
// Dia da semana ISO (1=seg..7=dom) de uma data civil.
function isoDow(dataISO) {
  const d = new Date(`${dataISO}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}
function toMs(v) {
  if (v == null) return null;
  const ms = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

// "quinta-feira, 18/09" — valor de {dia}.
function formatarDia(dataISO) {
  const [, m, d] = String(dataISO).split('-');
  return `${NOMES_DIA[isoDow(dataISO) % 7]}, ${d}/${m}`;
}
// "15h" ou "15h30" (hora de SP) — valor de {horario}.
function formatarHorario(instante) {
  const x = new Date(toMs(instante) - SP_OFFSET_MS);
  const h = x.getUTCHours(), m = x.getUTCMinutes();
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// R5 — horário de atendimento da unidade (tenants.horario_comercial)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
function _faixasDoDia(norm, dataISO, feriados) {
  if (!norm) return [];
  if (feriados && feriados.has(dataISO)) return [];
  return norm[isoDow(dataISO)] || [];
}
function _feriados(lista) {
  if (lista instanceof Set) return lista;
  return new Set(Array.isArray(lista) ? lista : []);
}

// Primeiro instante >= `desde` dentro de uma faixa aberta. null = sem horário configurado ou nada
// aberto em BUSCA_EXPEDIENTE_DIAS. Nunca antecipa.
function proximaAbertura(horarioCfg, desde, { feriados } = {}) {
  const norm = horario.normaliza(horarioCfg);
  const inicio = toMs(desde);
  if (!norm || inicio == null) return null;
  const fer = _feriados(feriados);
  let dia = dataSP(inicio);
  for (let i = 0; i <= LIMITES.BUSCA_EXPEDIENTE_DIAS; i++, dia = somarDias(dia, 1)) {
    const base = inicioDoDiaSP(dia);
    for (const f of _faixasDoDia(norm, dia, fer)) {
      const abre = base + f.ini * 60000, fecha = base + f.fim * 60000;
      if (inicio < fecha) return Math.max(abre, inicio);
    }
  }
  return null;
}

// Véspera: último dia aberto ANTES do dia do atendimento (recua até 3 dias), no fim do expediente —
// 18:00 se estiver aberto; senão o horário aberto mais tarde antes das 18:00 (30 min antes de fechar);
// se a unidade só abre depois das 18:00, a abertura. Garante que "amanhã" no texto é verdade ou quase.
function momentoVespera(horarioCfg, dataAtendimentoISO, { feriados } = {}) {
  const norm = horario.normaliza(horarioCfg);
  if (!norm) return null;
  const fer = _feriados(feriados);
  for (let recuo = 1; recuo <= LIMITES.VESPERA_MAX_DIAS_ATRAS; recuo++) {
    const dia = somarDias(dataAtendimentoISO, -recuo);
    const faixas = _faixasDoDia(norm, dia, fer);
    if (!faixas.length) continue;
    const pref = LIMITES.VESPERA_PREFERIDA_MIN;
    let escolhido = null;
    for (const f of faixas) {
      if (f.ini > pref) continue;
      const t = pref < f.fim ? pref : Math.max(f.ini, f.fim - 30);
      if (escolhido == null || t > escolhido) escolhido = t;
    }
    if (escolhido == null) escolhido = faixas[0].ini;
    return inicioDoDiaSP(dia) + escolhido * 60000;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Textos: variáveis, interpolação e plano de envio (R8, R10)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const VAR_RE = /\{([a-z][a-z0-9_]*)\}/g;

function variaveisUsadas(texto) {
  const out = new Set();
  for (const m of String(texto || '').matchAll(VAR_RE)) out.add(m[1]);
  return out;
}

// Variável com valor é trocada; sem valor, some (nunca vaza "{profissional}" para o cliente).
// Limpa o espaço que sobra no fim da linha.
function interpolar(texto, valores = {}) {
  return String(texto || '')
    .replace(VAR_RE, (_, k) => {
      const v = valores[k];
      return v == null ? '' : String(v).trim();
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]+$/, '');
}

function textoDaVersao(etapa, versao) {
  if (versao === 'responsavel' && etapa.texto_responsavel && String(etapa.texto_responsavel).trim()) {
    return etapa.texto_responsavel;
  }
  return etapa.texto_titular || '';
}

// R10 — como a mensagem vai para o WhatsApp. Devolve a sequência de envios.
//   sem anexo                       → [texto]
//   imagem/vídeo/documento          → [arquivo com o texto de legenda]  (texto <= 1024)
//                                   → [arquivo, texto]                  (texto maior)
//   áudio                           → [áudio, texto]  (WhatsApp não aceita legenda em áudio)
// Os envios em sequência contam como UMA mensagem para R3 e R7.
function planoDeEnvio({ texto, anexo } = {}) {
  const t = String(texto || '').trim();
  if (!anexo) return t ? [{ kind: 'texto', texto: t }] : [];
  const regra = ANEXO[anexo.tipo];
  if (!regra) throw new Error(`tipo de anexo desconhecido: ${anexo.tipo}`);
  const arquivo = { kind: 'arquivo', tipo: anexo.tipo, anexoId: anexo.id || null };
  if (!t) return [arquivo];
  if (regra.legenda && t.length <= LIMITE_LEGENDA) return [{ ...arquivo, legenda: t }];
  return [arquivo, { kind: 'texto', texto: t }];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Validação da configuração da unidade (usada pela tela antes de gravar)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
function validarAnexo({ tipo, mime, tamanhoBytes } = {}) {
  const regra = ANEXO[tipo];
  if (!regra) return [`Tipo de arquivo não aceito. Use imagem, vídeo, áudio ou documento.`];
  const erros = [];
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  if (regra.mimes && !regra.mimes.includes(base)) {
    erros.push(`Formato ${base || 'desconhecido'} não é aceito para ${tipo}. Aceitos: ${regra.mimes.join(', ')}.`);
  }
  const n = Number(tamanhoBytes);
  if (!Number.isFinite(n) || n <= 0) erros.push('Arquivo vazio.');
  else if (n > regra.maxBytes) erros.push(`O arquivo tem ${(n / MB).toFixed(1)} MB; o limite do WhatsApp para ${tipo} é ${regra.maxBytes / MB} MB.`);
  return erros;
}

function validarAlertaDias(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < LIMITES.ALERTA_MIN || v > LIMITES.ALERTA_MAX) {
    return [`O alerta de quem não começou deve ficar entre ${LIMITES.ALERTA_MIN} e ${LIMITES.ALERTA_MAX} dias.`];
  }
  return [];
}

const CHAVE_LIVRE_RE = /^[a-z][a-z0-9_]{1,30}$/;
function validarVariaveisLivres(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['As variáveis da unidade devem ser uma lista de nome e valor.'];
  const erros = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!CHAVE_LIVRE_RE.test(k)) erros.push(`Nome de variável inválido: "${k}". Use letras minúsculas, números e _ (ex.: link_ead).`);
    else if (VARIAVEIS_SISTEMA.includes(k)) erros.push(`"{${k}}" já é preenchida pelo sistema e não pode ser redefinida.`);
    if (typeof v !== 'string') erros.push(`O valor de "{${k}}" deve ser texto.`);
    else if (v.length > 500) erros.push(`O valor de "{${k}}" passa de 500 caracteres.`);
  }
  return erros;
}

// Erros estruturais de UMA etapa (os mesmos que os CHECKs da migr. 123 barrariam, com mensagem legível).
function validarEtapa(etapa) {
  const e = etapa || {};
  const erros = [];
  const nome = e.nome ? `"${e.nome}"` : `na posição ${e.ordem}`;
  if (!ANCORAS.includes(e.ancora)) erros.push(`Etapa ${nome}: momento de referência inválido.`);
  const q = e.quando || {};
  if (!TIPOS_QUANDO.includes(q.tipo)) {
    erros.push(`Etapa ${nome}: quando enviar é inválido.`);
  } else if (q.tipo === 'dias') {
    if (!Number.isInteger(q.valor) || q.valor < 0 || q.valor > LIMITES.OFFSET_MAX_DIAS) {
      erros.push(`Etapa ${nome}: o número de dias deve ficar entre 0 e ${LIMITES.OFFSET_MAX_DIAS}.`);
    }
  } else if (q.tipo === 'vespera' && e.ancora !== 'atendimento_agendado') {
    erros.push(`Etapa ${nome}: "véspera" só vale para atendimento agendado.`);
  } else if (q.tipo === 'proximo_expediente' && e.ancora === 'inicio_contrato') {
    erros.push(`Etapa ${nome}: "próximo horário de atendimento" só vale depois de um atendimento.`);
  }
  const rep = e.repeticoes == null ? 1 : e.repeticoes;
  if (!Number.isInteger(rep) || rep < 1 || rep > LIMITES.MAX_REPETICOES) {
    erros.push(`Etapa ${nome}: repetições devem ficar entre 1 e ${LIMITES.MAX_REPETICOES}.`);
  } else if (rep > 1 && e.ancora !== 'atendimento_agendado') {
    erros.push(`Etapa ${nome}: só a etapa de atendimento agendado pode se repetir.`);
  }
  const temTexto = e.texto_titular && String(e.texto_titular).trim();
  if (e.entregue_por !== 'externo' && !temTexto && !e.anexo_id) {
    erros.push(`Etapa ${nome}: precisa de texto ou de um arquivo.`);
  }
  return erros;
}

// Valida a régua inteira da unidade. `ancorasDisponiveis` = âncoras cuja fonte a unidade tem
// conectada (sem agenda integrada → só inicio_contrato). `variaveisLivres` = chaves da unidade.
function validarRegua(etapas, { ancorasDisponiveis = ANCORAS, variaveisLivres = [] } = {}) {
  const erros = [];
  const lista = Array.isArray(etapas) ? etapas : [];
  const ativas = lista.filter((e) => e && e.ativo !== false);
  const conhecidas = new Set([...VARIAVEIS_SISTEMA, ...variaveisLivres]);

  const ordens = new Set();
  for (const e of lista) {
    if (ordens.has(e.ordem)) erros.push(`Há duas etapas na posição ${e.ordem}.`);
    ordens.add(e.ordem);
  }

  // R4
  if (ativas.length < LIMITES.MIN_ETAPAS) erros.push(`A régua precisa de pelo menos ${LIMITES.MIN_ETAPAS} mensagens ligadas.`);
  if (ativas.length > LIMITES.MAX_ETAPAS) erros.push(`A régua pode ter no máximo ${LIMITES.MAX_ETAPAS} mensagens ligadas.`);

  for (const e of ativas) {
    erros.push(...validarEtapa(e));
    if (ANCORAS.includes(e.ancora) && !ancorasDisponiveis.includes(e.ancora)) {
      erros.push(`Etapa "${e.nome}": a unidade não tem ${e.ancora === 'atendimento_agendado' ? 'agenda' : 'registro de presença'} integrada ao Regente.`);
    }
    for (const texto of [e.texto_titular, e.texto_responsavel]) {
      for (const v of variaveisUsadas(texto)) {
        if (!conhecidas.has(v)) erros.push(`Etapa "${e.nome}": a variável {${v}} não existe. Confira o nome ou cadastre-a nas variáveis da unidade.`);
      }
    }
  }

  // R1 — a régua abre com uma mensagem do início do contrato em até 2 dias.
  const abertura = ativas.filter((e) => e.entregue_por !== 'externo' && e.ancora === 'inicio_contrato'
    && e.quando && e.quando.tipo === 'dias' && Number.isInteger(e.quando.valor) && e.quando.valor <= LIMITES.PRIMEIRA_MAX_DIAS);
  if (ativas.length && !abertura.length) {
    erros.push(`A primeira mensagem precisa sair em até ${LIMITES.PRIMEIRA_MAX_DIAS} dias do início do contrato.`);
  }

  // R3 (parte estática) — mesma âncora, em dias: pelo menos 2 dias de distância.
  for (const ancora of ANCORAS) {
    const emDias = ativas
      .filter((e) => e.entregue_por !== 'externo' && e.ancora === ancora && e.quando && e.quando.tipo === 'dias' && Number.isInteger(e.quando.valor))
      .sort((a, b) => a.quando.valor - b.quando.valor);
    for (let i = 1; i < emDias.length; i++) {
      if ((emDias[i].quando.valor - emDias[i - 1].quando.valor) * 24 < LIMITES.ESPACO_MIN_HORAS) {
        erros.push(`"${emDias[i - 1].nome}" e "${emDias[i].nome}" ficam a menos de ${LIMITES.ESPACO_MIN_HORAS / 24} dias uma da outra.`);
      }
    }
  }

  return { ok: erros.length === 0, erros: [...new Set(erros)] };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Elegibilidade (R9, contrato curto) e teto (R2)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// R9 — só contratação nova: o beneficiário não tem contrato que começou ANTES deste. Contratos que
// começam no mesmo dia (dois cursos na mesma matrícula) contam como novos.
function ehContratacaoNova({ iniVigencia, outrosContratos = [] } = {}) {
  if (!ISO_DATA.test(String(iniVigencia))) return false;
  return !outrosContratos.some((c) => c && ISO_DATA.test(String(c.iniVigencia)) && c.iniVigencia < iniVigencia);
}

function ehContratoCurto({ iniVigencia, fimVigencia } = {}) {
  if (!ISO_DATA.test(String(iniVigencia)) || !ISO_DATA.test(String(fimVigencia))) return false;
  return diasEntre(iniVigencia, fimVigencia) <= LIMITES.CONTRATO_CURTO_DIAS;
}

// R2 — último dia (SP) em que uma mensagem da régua pode sair:
// min(início + 60, início + 50% da vigência, véspera do início da régua de renovação).
// CONTRATO CURTO ignora o início da renovação: num contrato de 30 dias a renovação já começa no
// dia da matrícula (marco D-30), e a proteção contra a colisão é a régua reduzida (só as etapas
// marcadas para contrato curto) somada ao teto de 50%. Sem essa exceção o mensal nunca teria
// boas-vindas.
function tetoDaRegua({ iniVigencia, fimVigencia, inicioRenovacao } = {}) {
  let teto = somarDias(iniVigencia, LIMITES.TETO_DIAS);
  if (ISO_DATA.test(String(fimVigencia))) {
    const metade = somarDias(iniVigencia, Math.floor(diasEntre(iniVigencia, fimVigencia) * LIMITES.FRACAO_VIGENCIA));
    if (metade < teto) teto = metade;
  }
  if (ISO_DATA.test(String(inicioRenovacao)) && !ehContratoCurto({ iniVigencia, fimVigencia })) {
    const antes = somarDias(inicioRenovacao, -1);
    if (antes < teto) teto = antes;
  }
  return teto;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Cálculo das mensagens de um contrato
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const _presaAoAtendimento = (e) => e.quando && (e.quando.tipo === 'vespera' || e.quando.tipo === 'proximo_expediente');

// conta:  { iniVigencia, fimVigencia, inicioRenovacao? }
// fatos:  { atendimentos: [{ inicio, fim }], primeiroAtendimento: { inicio, fim } | null }
//         (instantes ISO/ms; `atendimentos` = os agendados do contrato, em qualquer ordem)
// Devolve, por etapa × repetição: { etapa, repeticao, ancoraData, dueAt (ms) | null, situacao }
//   situacao: 'agendada' | 'aguardando_ancora' | 'fora_da_janela' | 'sem_horario_atendimento' | 'externa'
function calcularMensagens({ conta, etapas, fatos = {}, horario: horarioCfg, feriados } = {}) {
  if (!conta || !ISO_DATA.test(String(conta.iniVigencia))) throw new Error('conta.iniVigencia obrigatória (YYYY-MM-DD)');
  const fer = _feriados(feriados);
  const curto = ehContratoCurto(conta);
  const teto = tetoDaRegua(conta);
  const tetoFimMs = inicioDoDiaSP(somarDias(teto, 1));   // até 23:59 do dia do teto
  const agendados = (fatos.atendimentos || [])
    .map((a) => ({ inicio: toMs(a.inicio), fim: toMs(a.fim) }))
    .filter((a) => a.inicio != null && dataSP(a.inicio) >= conta.iniVigencia)
    .sort((a, b) => a.inicio - b.inicio);
  const primeiro = fatos.primeiroAtendimento && toMs(fatos.primeiroAtendimento.inicio) != null
    ? { inicio: toMs(fatos.primeiroAtendimento.inicio), fim: toMs(fatos.primeiroAtendimento.fim) }
    : null;

  const saida = [];
  const ativas = (etapas || [])
    .filter((e) => e && e.ativo !== false)
    .filter((e) => !curto || e.contrato_curto === true)
    .sort((a, b) => a.ordem - b.ordem);

  for (const e of ativas) {
    const reps = e.ancora === 'atendimento_agendado' ? (e.repeticoes || 1) : 1;
    for (let r = 1; r <= reps; r++) {
      const item = { etapa: e, repeticao: r, ancoraData: null, dueAt: null, atendimento: null, situacao: 'agendada' };
      let ancoraMs = null, atendimento = null;
      if (e.ancora === 'inicio_contrato') {
        item.ancoraData = conta.iniVigencia;
      } else if (e.ancora === 'atendimento_agendado') {
        atendimento = agendados[r - 1] || null;
      } else {
        atendimento = primeiro;
      }
      if (e.ancora !== 'inicio_contrato') {
        if (!atendimento) { item.situacao = 'aguardando_ancora'; saida.push(item); continue; }
        item.atendimento = atendimento;
        ancoraMs = atendimento.inicio;
        item.ancoraData = dataSP(ancoraMs);
      }

      if (e.entregue_por === 'externo') {
        item.situacao = 'externa';
        if (e.quando.tipo === 'dias') item.dueAt = inicioDoDiaSP(somarDias(item.ancoraData, e.quando.valor));
        saida.push(item);
        continue;
      }

      let due = null;
      if (e.quando.tipo === 'dias') {
        due = proximaAbertura(horarioCfg, inicioDoDiaSP(somarDias(item.ancoraData, e.quando.valor)), { feriados: fer });
      } else if (e.quando.tipo === 'vespera') {
        due = momentoVespera(horarioCfg, item.ancoraData, { feriados: fer });
      } else {
        due = proximaAbertura(horarioCfg, atendimento.fim != null ? atendimento.fim : ancoraMs, { feriados: fer });
      }
      if (due == null) { item.situacao = 'sem_horario_atendimento'; saida.push(item); continue; }
      item.dueAt = due;
      if (due >= tetoFimMs) item.situacao = 'fora_da_janela';
      saida.push(item);
    }
  }

  // R3 (em execução) — 48 h entre mensagens agendadas, exceto as presas a um atendimento. A mais
  // tardia é empurrada para a próxima abertura depois das 48 h; nunca antecipa. Pode cair fora do teto.
  const espacaveis = saida
    .filter((m) => m.situacao === 'agendada' && !_presaAoAtendimento(m.etapa))
    .sort((a, b) => a.dueAt - b.dueAt || a.etapa.ordem - b.etapa.ordem);
  for (let i = 1; i < espacaveis.length; i++) {
    const ant = espacaveis[i - 1], cur = espacaveis[i];
    const minimo = ant.dueAt + LIMITES.ESPACO_MIN_HORAS * 3600000;
    if (cur.dueAt < minimo) {
      const novo = proximaAbertura(horarioCfg, minimo, { feriados: fer });
      if (novo == null) { cur.situacao = 'sem_horario_atendimento'; cur.dueAt = null; espacaveis.splice(i--, 1); continue; }
      cur.dueAt = novo;
      if (novo >= tetoFimMs) { cur.situacao = 'fora_da_janela'; espacaveis.splice(i--, 1); continue; }
      espacaveis.sort((a, b) => a.dueAt - b.dueAt || a.etapa.ordem - b.etapa.ordem);
      i = 0;   // recomeça: a mudança pode reordenar
    }
  }

  return saida.sort((a, b) => (a.dueAt == null) - (b.dueAt == null) || a.dueAt - b.dueAt || a.etapa.ordem - b.etapa.ordem);
}

// R6 — em relação a `agora`: 'futura' | 'devida' | 'vencida'.
// Véspera vence à 00:00 do dia do atendimento (depois disso "amanhã" seria mentira).
function situacaoAgora(mensagem, agora) {
  const now = toMs(agora);
  if (mensagem.dueAt == null || now == null) return 'futura';
  if (now < mensagem.dueAt) return 'futura';
  const limite = mensagem.etapa && mensagem.etapa.quando && mensagem.etapa.quando.tipo === 'vespera'
    ? inicioDoDiaSP(mensagem.ancoraData)
    : mensagem.dueAt + LIMITES.GRACE_DIAS * DIA_MS;
  return now < limite ? 'devida' : 'vencida';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Destinatário, pré-requisitos (R8), uma por família (R7) e alerta
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// pessoas: { beneficiario: { personId, nome, telefone }, pagador?: { personId, nome, telefone } }
//   pagador ≠ beneficiário → versão responsável, telefone do pagador (senão o do beneficiário)
//   pagador = beneficiário ou ausente → versão titular, telefone do beneficiário (senão o do pagador)
function escolherDestinatario({ beneficiario, pagador } = {}) {
  const b = beneficiario || {};
  const p = pagador || null;
  const outraPessoa = Boolean(p && p.personId && p.personId !== b.personId);
  const base = { clienteNome: b.nome || null, responsavelNome: outraPessoa ? (p.nome || null) : null };
  if (outraPessoa) {
    // O texto é o do responsável mesmo quando só o aluno tem telefone: quem lê pode ser o aluno,
    // mas a mensagem continua falando com a família, como a planilha escreveu.
    const quem = p.telefone ? p : (b.telefone ? b : p);
    return { ...base, versao: 'responsavel', personId: quem.personId || null, telefone: quem.telefone || null,
      destinatarioNome: quem.nome || null };
  }
  const quem = b.telefone ? b : (p && p.telefone ? p : b);
  return { ...base, versao: 'titular', personId: quem.personId || null, telefone: quem.telefone || null,
    destinatarioNome: quem.nome || null };
}

// R8 — o que impede a mensagem de sair. null = pode sair.
// valores: as variáveis já resolvidas ({ dia, horario, profissional, … }).
function bloqueioDaMensagem({ etapa, versao, valores = {}, telefone, anexoDisponivel = true } = {}) {
  if (!telefone) return 'sem_telefone';
  const usadas = variaveisUsadas(textoDaVersao(etapa, versao));
  for (const v of VARIAVEIS_FATO) {
    if (usadas.has(v) && !(valores[v] != null && String(valores[v]).trim())) return BLOQUEIO_POR_FATO[v];
  }
  if (etapa.anexo_id && !anexoDisponivel) return 'sem_anexo';
  return null;
}

// R7 — uma mensagem por telefone por dia (SP).
// Entrada: mensagens devidas [{ chave, telefone, dueAt, etapaId, ordem, presaAoAtendimento }].
//   mesma etapa, mesmo telefone, mesmo dia (irmãos) → uma fica, as outras são AGRUPADAS nela;
//   etapas diferentes no mesmo dia → fica a presa ao atendimento (senão a de menor ordem); as outras
//   são ADIADAS para a próxima abertura do dia seguinte (o job reavalia no outro dia).
function umaPorFamilia(mensagens, { horario: horarioCfg, feriados } = {}) {
  const grupos = new Map();
  for (const m of mensagens || []) {
    if (!m || !m.telefone || m.dueAt == null) continue;
    const k = `${String(m.telefone).replace(/\D/g, '')}|${dataSP(m.dueAt)}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(m);
  }
  const manter = [], agrupadas = [], adiadas = [];
  for (const lista of grupos.values()) {
    lista.sort((a, b) => (b.presaAoAtendimento === true) - (a.presaAoAtendimento === true)
      || a.ordem - b.ordem || String(a.chave).localeCompare(String(b.chave)));
    const escolhida = lista[0];
    manter.push(escolhida);
    for (const m of lista.slice(1)) {
      if (m.etapaId === escolhida.etapaId) {
        agrupadas.push({ mensagem: m, com: escolhida.chave });
      } else {
        const novo = proximaAbertura(horarioCfg, inicioDoDiaSP(somarDias(dataSP(m.dueAt), 1)), { feriados });
        adiadas.push({ mensagem: m, novoDueAt: novo });
      }
    }
  }
  return { manter, agrupadas, adiadas };
}

// Alerta de cliente que não começou: sem 1º atendimento depois de N dias do início do contrato.
function precisaAlertaSemInicio({ iniVigencia, primeiroAtendimento, hoje, alertaDias = LIMITES.ALERTA_PADRAO } = {}) {
  if (primeiroAtendimento) return false;
  if (!ISO_DATA.test(String(iniVigencia)) || !ISO_DATA.test(String(hoje))) return false;
  return diasEntre(iniVigencia, hoje) >= alertaDias;
}

module.exports = {
  ANCORAS, TIPOS_QUANDO, LIMITES, VARIAVEIS_SISTEMA, VARIAVEIS_FATO, ANEXO, LIMITE_LEGENDA,
  // datas
  inicioDoDiaSP, dataSP, somarDias, diasEntre, formatarDia, formatarHorario,
  // horário de atendimento
  proximaAbertura, momentoVespera,
  // textos
  variaveisUsadas, interpolar, textoDaVersao, planoDeEnvio,
  // validação
  validarAnexo, validarAlertaDias, validarVariaveisLivres, validarEtapa, validarRegua,
  // elegibilidade e cálculo
  ehContratacaoNova, ehContratoCurto, tetoDaRegua, calcularMensagens, situacaoAgora,
  // destinatário e travas
  escolherDestinatario, bloqueioDaMensagem, umaPorFamilia, precisaAlertaSemInicio,
};
