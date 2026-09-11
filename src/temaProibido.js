'use strict';
//
// temaProibido.js — ASSUNTOS QUE SÓ A RECEPÇÃO RESPONDE. A assistente virtual não trata nenhum deles
// sozinha; quando o cliente toca num deles, ela só avisa que a equipe vai avaliar no horário de
// atendimento (mensagemEncaminhamento — texto FIXO, sem IA). Vale para todo envio que sai SEM um
// humano no meio (resposta fora do horário; o auto-envio da renovação usa a trava de saída). A
// sugestão do campo verde não passa aqui: nela a recepção lê antes de enviar.
//
//   Travas por UNIDADE (automacao_config, padrão ligado):
//     • AGENDA   — dia/horário de aula, agendar, confirmar, remarcar, repor, antecipar  (agendamento_sempre_manual)
//     • VALORES  — preço, mensalidade, pagamento, desconto, matrícula                    (proposta_sempre_manual)
//   Sempre ligadas, em QUALQUER unidade (regra do Leo, 11/09/2026 — não é escolha da franquia):
//     • CONTRATO    — contrato, cancelamento, rescisão, multa, trancamento, desistência
//     • JURÍDICO    — advogado, Procon, processo, lei, direitos do consumidor, LGPD…
//     • RECLAMAÇÃO  — insatisfação, reclamação, "ninguém responde"…
//     • CRÍTICO     — urgência, acidente, saúde, luto, assédio, violência…
//
// POR QUE REGEX E NÃO O PROMPT: o prompt JÁ proibia agenda — e em 30 dias a IA confirmou agenda de
// aula pelo menos 5 vezes. Em 11/09 confirmou o horário ERRADO para uma mãe ("11h, como combinamos"):
// o 11h estava escrito numa conversa antiga, antes de a aula ser antecipada para 12h. A regra "só
// afirme o que está escrito" não tem como saber o que envelheceu. Aqui a decisão é determinística e
// erra para o lado seguro: na dúvida, vai o aviso fixo e a recepção responde quando abrir.
//
// MULTI-TENANT: as palavras são do DOMÍNIO (escola), nada de nome de unidade, professor ou aluno; o
// aviso usa o nome da escola e a hora de retorno de cada unidade.

// Sem acento e minúsculo: "Horário"/"horario", "às"/"as", "terça"/"terca" viram a mesma coisa.
function _norm(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// ---- peças comuns --------------------------------------------------------------------------------
// Hora/data escritas: 11h, 19h30, 9 h, 12:00, "às 12", dia 15, 15/09.
const RE_HORA = /\b\d{1,2}\s?h(?:\s?\d{2})?\b|\b\d{1,2}:\d{2}\b|\bas \d{1,2}\b/;
const RE_DATA = /\bdia \d{1,2}\b|\b\d{1,2}\/\d{1,2}\b/;
// Palavras de DIA (sozinhas não bastam — "bom dia" não é agenda; valem junto de "aula").
const RE_DIA = /\b(hoje|amanha|ontem|semana que vem|proxima semana|fim de semana|feriado|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/;
const RE_AULA = /\b(aula|aulas|experimental|experimentais|turma|ensaio)\b/;

// ---- ENTRADA (a mensagem do cliente) ------------------------------------------------------------
const RE_AGENDA_EXPLICITA = /\b(horario|horarios|que horas|agend\w*|remarc\w*|desmarc\w*|reagend\w*|repor|reposic\w*|antecip\w*|adiant\w*)\b/;
// Com "aula" na frase: confirmar, cancelar, faltar, mudar, trocar, "não vou/consigo".
const RE_AGENDA_COM_AULA = /\b(confirm\w*|cancel\w*|falt\w*|marc(ar|ada|ado|amos|ou)|mud\w*|troc\w*|nao (vou|vai|consigo|poderei|podera))\b/;
const RE_VALORES_ENTRADA = /\b(valor|valores|preco|precos|quanto (custa|e|fica|sai|cobra|seria|cobram)|mensalidade\w*|matricula\w*|desconto\w*|promoc\w*|pagament\w*|pagar|paguei|pag(a|o|ou)|boleto\w*|pix|cartao|parcel\w*|reais|taxa|cobranc\w*|fatura\w*|reembols\w*|comprovante\w*|planos?)\b|r\$/;
const RE_CONTRATO = /\b(contrato\w*|cancel\w*|rescis\w*|rescindir|multa\w*|fidelidade|tranc(ar|amento|ado|ada)|desist\w*|sair da escola|parar (as|de fazer as|com as) aulas?|encerr\w*)\b/;
// "direito" sozinho não ("aprender a tocar direito" é de lead); só as formas de direito do cliente.
const RE_JURIDICO = /\b(advogad\w*|juridic\w*|procon|justica|judicia\w*|processar|processo judicial|lei|leis|legisla\w*|direitos|meus direitos|tenho direito|temos direito|codigo de defesa|consumidor|lgpd|danos morais|indeniza\w*|extrajudicial|reclame aqui|tribunal|boletim de ocorrencia)\b/;
const RE_RECLAMACAO = /\b(reclama\w*|reclamo|insatisfeit\w*|decepcionad\w*|decepcao|absurdo|pessim\w*|horrivel|lamentavel|vergonh\w*|descaso|desrespeit\w*|falta de respeito|indignad\w*|revoltad\w*|chatead\w*|irritad\w*|nao gostei|muito ruim|ninguem (me )?(responde|respondeu|retorna|retornou)|sem resposta|mal atendid\w*)\b/;
const RE_CRITICO = /\b(urgente|urgencia|emergencia|acidente|machuc\w*|lesao|ferid[oa]s?|hospital\w*|passou mal|desmai\w*|faleceu|falecimento|luto|obito|assedi\w*|abus\w*|bullying|agress\w*|violencia|briga\w*|ameac\w*|furt\w*|roub\w*|policia|denuncia\w*|suicid\w*|depressao|crise)\b/;

const _achou = (re, t) => { const m = re.exec(t); return m ? m[0] : null; };

// Devolve, por tema, o TRECHO que casou (p/ o log dizer por quê) ou null.
function detectarEntrada(texto) {
  const t = _norm(texto);
  let agenda = _achou(RE_AGENDA_EXPLICITA, t) || _achou(RE_HORA, t) || _achou(RE_DATA, t);
  if (!agenda && RE_AULA.test(t)) agenda = _achou(RE_DIA, t) || _achou(RE_AGENDA_COM_AULA, t);
  return {
    critico: _achou(RE_CRITICO, t),
    juridico: _achou(RE_JURIDICO, t),
    reclamacao: _achou(RE_RECLAMACAO, t),
    agenda,
    contrato: _achou(RE_CONTRATO, t),
    valores: _achou(RE_VALORES_ENTRADA, t),
  };
}

// ---- SAÍDA (o que a IA escreveu, antes de enviar) -----------------------------------------------
// A frase de retorno ("hoje às 9h", "na segunda-feira às 9h") é CALCULADA pelo sistema e obrigatória
// no prompt — chega em `permitidos` e é removida antes de checar. Qualquer outra hora/data é bloqueio.
// "confirmado/agendado…" só pesa com "aula" junto: "os detalhes são confirmados pela recepção" é
// um desvio correto e tem de passar.
const RE_STATUS_AULA = /\b(confirmad\w*|agendad\w*|marcad\w*|remarcad\w*|reagendad\w*|desmarcad\w*|cancelad\w*|combinamos|combinado para)\b/;
const RE_VALORES_SAIDA = /r\$\s?\d|\b\d+\s?reais\b|\b\d{2,4},\d{2}\b|\b(boleto\w*|pix|cartao|parcel\w*|mensalidade\w*|desconto\w*|promoc\w*)\b/;
// A IA prometendo condição de contrato ("pode cancelar sem multa") — nunca sai sozinho.
const RE_CONTRATO_SAIDA = /\b(contrato\w*|multa\w*|rescis\w*|fidelidade|cancelament\w*|cancelar sem)\b/;

function detectarSaida(texto, { permitidos = [] } = {}) {
  let t = _norm(texto);
  for (const p of permitidos) {
    const n = _norm(p).trim();
    if (n) t = t.split(n).join(' ');
  }
  let agenda = _achou(RE_HORA, t) || _achou(RE_DATA, t);
  if (!agenda && RE_AULA.test(t)) agenda = _achou(RE_STATUS_AULA, t) || _achou(RE_DIA, t);
  return { agenda, contrato: _achou(RE_CONTRATO_SAIDA, t), valores: _achou(RE_VALORES_SAIDA, t) };
}

// Travas da unidade (agenda/valores: nulo/ausente = ligada) + as que valem para todas as unidades.
function regrasDoTenant(cfg) {
  const c = cfg || {};
  return {
    critico: true, juridico: true, reclamacao: true, contrato: true,
    agenda: c.agendamento_sempre_manual !== false,
    valores: c.proposta_sempre_manual !== false,
  };
}

// Ordem = prioridade do rótulo no log (o efeito é o mesmo: vai para a recepção).
const _ORDEM = ['critico', 'juridico', 'reclamacao', 'agenda', 'contrato', 'valores'];

// Aplica as travas ligadas sobre uma detecção: { tema, trecho } ou null (liberado).
function bloqueio(det, regras) {
  if (!det) return null;
  for (const k of _ORDEM) if (regras[k] && det[k]) return { tema: k, trecho: det[k] };
  return null;
}

// O ÚNICO texto que a assistente manda quando o assunto é da recepção: não responde o assunto, não
// afirma nada, só avisa que a equipe vai avaliar no horário de atendimento. Fixo e sem IA.
function mensagemEncaminhamento({ nome, escola, proxima } = {}) {
  const oi = nome ? `Oi, ${nome}!` : 'Oi!';
  const quem = escola ? `pela equipe da ${escola}` : 'pela nossa equipe';
  const quando = proxima ? ` — voltamos ${proxima}` : '';
  return `${oi} Recebemos sua mensagem 🙌 Isso vai ser avaliado ${quem} durante o horário de atendimento${quando}.`;
}

module.exports = { detectarEntrada, detectarSaida, regrasDoTenant, bloqueio, mensagemEncaminhamento, _norm };
