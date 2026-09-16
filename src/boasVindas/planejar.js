'use strict';
//
// planejar.js — ADR-050 (E17-02). Decide, para cada contrato novo de uma unidade, quais mensagens de
// boas-vindas existem, quando saem, para quem, com que texto e em que estado. PURO: recebe tudo já
// carregado (contratos, régua, fatos da agenda, mensagens já registradas, "agora") e devolve o plano.
// O job diário grava o plano; a simulação só mostra. É a MESMA função nos dois casos.
//
// Nunca envia nada. Em modo "avisa" a mensagem fica pendente para a recepção.
//
const R = require('../boasVindasRegua');
const { RENOVACAO_PRIMEIRO_MARCO_DIAS } = require('./dados');

// Estados que a recepção (ou o envio) já tratou: o planejamento nunca mais mexe neles.
const FINAIS = new Set(['aprovado', 'enviado', 'descartado', 'erro']);
const NA_FILA = new Set(['pendente', 'bloqueado']);

// "MARIA DA SILVA" → "Maria"; "Pedro Henrique" → "Pedro".
function nomeCurto(nome) {
  const p = String(nome || '').trim().split(/\s+/)[0];
  if (!p) return null;
  return p === p.toUpperCase() ? p.charAt(0) + p.slice(1).toLowerCase() : p;
}

function _juntarNomes(nomes) {
  const u = [...new Set(nomes.filter(Boolean))];
  if (u.length <= 1) return u[0] || null;
  return `${u.slice(0, -1).join(', ')} e ${u[u.length - 1]}`;
}

const _chave = (accountId, etapaId, repeticao) => `${accountId}|${etapaId}|${repeticao}`;

// Plano de UM contrato. `fatos` = { atendimentos, primeiroAtendimento } do adaptador (ou {} sem agenda).
function planejarContrato({ contrato, etapas, fatos = {}, fonteAgenda = false, config, agora: agoraIn, feriados } = {}) {
  const ct = contrato;
  const agora = typeof agoraIn === 'number' ? agoraIn : Date.parse(agoraIn);
  const base = {
    accountId: ct.accountId, iniVigencia: ct.iniVigencia, fimVigencia: ct.fimVigencia, servico: ct.servico,
    periodicidade: ct.periodicidade, clienteNome: ct.beneficiario ? ct.beneficiario.nome : null,
    contratoExt: ct.contratoExt, aulasEncontradas: (fatos.atendimentos || []).length,
    primeiroAtendimento: fatos.primeiroAtendimento || null, toques: [], linhaDoTempo: [],
  };
  if (ct.contatoInterno) return { ...base, elegivel: false, motivo: 'contato_interno' };
  if (ct.temContratoAnterior) return { ...base, elegivel: false, motivo: 'renovacao' };
  if (!ct.beneficiario) return { ...base, elegivel: false, motivo: 'sem_titular' };

  const dest = R.escolherDestinatario({ beneficiario: ct.beneficiario, pagador: ct.pagador });
  const conta = {
    iniVigencia: ct.iniVigencia,
    fimVigencia: ct.fimVigencia,
    inicioRenovacao: ct.fimVigencia ? R.somarDias(ct.fimVigencia, -RENOVACAO_PRIMEIRO_MARCO_DIAS) : null,
  };
  const fatosMotor = fonteAgenda ? fatos : {};
  const msgs = R.calcularMensagens({ conta, etapas, fatos: fatosMotor, horario: config.horario, feriados });
  // Etapas do início do contrato citam a PRÓXIMA aula a partir de agora — nunca uma que já passou.
  const proximaAula = (fatosMotor.atendimentos || []).find((a) => a.inicio > agora) || null;
  const primeiraRealizada = fatosMotor.primeiroAtendimento || null;
  const valoresBase = {
    ...(config.variaveis || {}),                       // variáveis livres primeiro: as do sistema não são sobrescritas
    cliente: nomeCurto(ct.beneficiario.nome),
    responsavel: dest.responsavelNome ? nomeCurto(dest.responsavelNome) : null,
    empresa: config.empresa,
    servico: ct.servico,
  };

  const toques = [];
  const linhaDoTempo = [];
  for (const m of msgs) {
    const e = m.etapa;
    const item = { etapaId: e.id, etapaNome: e.nome, ordem: e.ordem, repeticao: m.repeticao, situacao: m.situacao, dueAt: m.dueAt, ancoraData: m.ancoraData };
    linhaDoTempo.push(item);
    if (m.situacao === 'externa' || m.situacao === 'aguardando_ancora') continue;

    const atendimento = m.atendimento || (e.ancora === 'inicio_contrato' ? proximaAula : null);
    const valores = {
      ...valoresBase,
      dia: atendimento ? R.formatarDia(R.dataSP(atendimento.inicio)) : null,
      horario: atendimento ? R.formatarHorario(atendimento.inicio) : null,
      profissional: nomeCurto((atendimento && atendimento.profissional) || ct.professorNome),
    };
    let status, bloqueio = null, motivo = null, momento = null, dueAt = m.dueAt;
    let limite = R.limiteDaMensagem(m);
    if (m.situacao === 'fora_da_janela') {
      status = 'fora_da_janela'; motivo = 'passa_do_limite_da_regua';
    } else if (m.situacao === 'sem_horario_atendimento') {
      status = 'bloqueado'; bloqueio = 'sem_horario_atendimento'; dueAt = R.inicioDoDiaSP(m.ancoraData);
    } else {
      // R6 — exceção: etapa do início do contrato que cita a aula ({dia}/{horario}/{profissional}) atrasa
      // por falta de DADO (a agenda só mostra a semana corrente), não por culpa da família. Ela vale até
      // o dia seguinte à 1ª aula; enquanto a 1ª aula não acontece, segue valendo (dentro do teto R2).
      const citaAula = e.ancora === 'inicio_contrato'
        && [...R.variaveisUsadas(R.textoDaVersao(e, dest.versao))].some((v) => R.VARIAVEIS_FATO.includes(v));
      if (citaAula) limite = Math.max(limite, primeiraRealizada ? primeiraRealizada.fim + 86400000 : Infinity);
      momento = agora < m.dueAt ? 'futura' : (agora < limite ? 'devida' : 'vencida');
      if (momento === 'vencida') {
        status = 'fora_da_janela'; motivo = 'passou_do_prazo';
      } else {
        bloqueio = R.bloqueioDaMensagem({ etapa: e, versao: dest.versao, valores, telefone: dest.telefone });
        status = bloqueio ? 'bloqueado' : 'pendente';
        if (!bloqueio && e.anexo_sugerido && !e.anexo_id) motivo = 'anexo_nao_configurado';
      }
    }
    toques.push({
      chave: _chave(ct.accountId, e.id, m.repeticao),
      accountId: ct.accountId, etapaId: e.id, etapaNome: e.nome, ordem: e.ordem, repeticao: m.repeticao,
      ancoraData: m.ancoraData, dueAt, momento, limite: Number.isFinite(limite) ? limite : null,
      urgente: Boolean(e.quando && e.quando.tipo === 'vespera'),
      presaAoAtendimento: Boolean(e.quando && (e.quando.tipo === 'vespera' || e.quando.tipo === 'proximo_expediente')),
      versao: dest.versao, personId: dest.personId, phone: dest.telefone,
      destinatarioNome: dest.destinatarioNome, clienteNome: ct.beneficiario.nome,
      etapa: e, valores, textoFinal: R.interpolar(R.textoDaVersao(e, dest.versao), valores),
      anexoId: e.anexo_id || null, status, bloqueio, motivo,
    });
  }

  const alertaSemInicio = fonteAgenda && R.precisaAlertaSemInicio({
    iniVigencia: ct.iniVigencia, primeiroAtendimento: fatos.primeiroAtendimento, hoje: R.dataSP(agora), alertaDias: config.alertaDias,
  });
  return { ...base, elegivel: true, destinatario: dest, alertaSemInicio, toques, linhaDoTempo };
}

// R7 + R3 sobre a unidade inteira: por família, uma mensagem por vez, 48 h entre elas.
function _umaPorFamilia(planos, existentes, { config, agora, feriados }) {
  const hoje = R.dataSP(agora);
  const candidatos = [];
  for (const p of planos) for (const t of p.toques) {
    if (t.status !== 'pendente') continue;
    // Devidas agora concorrem; o lembrete da aula que ainda vai sair HOJE também entra, só para
    // reservar o dia da família (senão a mensagem comum sairia de manhã e o lembrete à tarde).
    if (t.momento === 'devida' || (t.urgente && t.momento === 'futura' && R.dataSP(t.dueAt) === hoje)) candidatos.push(t);
  }
  const presaPorEtapa = new Map();
  for (const p of planos) for (const t of p.toques) presaPorEtapa.set(t.etapaId, t.presaAoAtendimento);
  const envios = existentes
    .filter((x) => (x.status === 'enviado' || x.status === 'aprovado') && x.phone)
    .map((x) => ({ telefone: x.phone, em: new Date(x.enviado_em || x.due_at).getTime(), presaAoAtendimento: presaPorEtapa.get(x.etapa_id) === true }));
  const entrada = candidatos.map((t) => ({ ...t, telefone: t.phone, toque: t }));
  const { agrupadas, adiadas, manter } = R.umaPorFamilia(entrada, { horario: config.horario, feriados, agora, envios });

  const porChave = new Map(entrada.map((x) => [x.chave, x]));
  for (const a of agrupadas) {
    const t = a.mensagem.toque;
    const principal = porChave.get(a.com);
    t.status = 'descartado';
    t.motivo = `agrupada_na_mensagem_de_${principal && principal.toque ? principal.toque.valores.cliente : 'outra_conta'}`;
    if (principal && principal.toque) {
      const p = principal.toque;
      p.irmaos = [...(p.irmaos || []), t.valores.cliente];
      p.valores = { ...p.valores, cliente: _juntarNomes([nomeCurto(p.clienteNome), ...p.irmaos]) };
      p.textoFinal = R.interpolar(R.textoDaVersao(p.etapa, p.versao), p.valores);
    }
  }
  for (const a of adiadas) {
    const t = a.mensagem.toque;
    if (!t) continue;
    if (a.novoDueAt == null) { t.status = 'bloqueado'; t.bloqueio = 'sem_horario_atendimento'; }
    else { t.dueAt = a.novoDueAt; t.momento = 'futura'; t.motivo = 'adiada_uma_mensagem_por_vez_para_a_familia'; }
  }
  return { agrupadas: agrupadas.length, adiadas: adiadas.length, mantidas: manter.length };
}

// Compara com o que já está gravado: criar | atualizar | manter.
function _acao(t, existente) {
  if (!existente) return 'criar';
  if (FINAIS.has(existente.status)) return 'manter';
  const due = existente.due_at ? new Date(existente.due_at).getTime() : null;
  const igual = due === t.dueAt && existente.status === t.status && (existente.bloqueio || null) === (t.bloqueio || null)
    && (existente.texto_final || null) === (t.textoFinal || null) && (existente.phone || null) === (t.phone || null)
    && (existente.motivo || null) === (t.motivo || null) && existente.versao === t.versao
    && (existente.anexo_id || null) === (t.anexoId || null);
  return igual ? 'manter' : 'atualizar';
}

// Plano da unidade inteira.
//   contratos       saída de dados.carregarContratos
//   fatosPorConta   Map accountId → { atendimentos, primeiroAtendimento }
//   existentes      linhas de boas_vindas_toque desses contratos
//   ativacao        true = trata AGORA como o instante da ativação (simulação --dry --ativar)
//   config.ativadoEm instante (ms) em que a unidade saiu de 'desligado' (E17-05). O que venceu em DIAS ANTERIORES
//                   ao da ativação e ainda não estava na fila vira fora_da_janela (motivo anterior_a_ativacao)
//                   em TODA rodada — a família não recebe de uma vez o atraso acumulado (R6). O que vence no
//                   próprio dia da ativação segue valendo: a matrícula da manhã não se perde porque a gestão
//                   ligou à tarde.
function planejarUnidade({ contratos, etapas, fatosPorConta = new Map(), fonteAgenda = false, config, agora, feriados = [], existentes = [], ativacao = false } = {}) {
  const planos = contratos.map((ct) => planejarContrato({
    contrato: ct, etapas, fatos: fatosPorConta.get(ct.accountId) || {}, fonteAgenda, config, agora, feriados,
  }));
  const existentesPorChave = new Map(existentes.map((x) => [_chave(x.account_id, x.etapa_id, x.repeticao), x]));

  // Mensagem já tratada pela recepção fica como está: nem entra no R7 como candidata.
  for (const p of planos) {
    for (const t of p.toques) {
      const ex = existentesPorChave.get(t.chave);
      if (ex && FINAIS.has(ex.status)) { t.status = ex.status; t.momento = null; t.bloqueado_pela_recepcao = true; }
    }
  }
  const agoraMs = typeof agora === 'number' ? agora : Date.parse(agora);
  const ativadoEm = ativacao ? agoraMs : (config && Number.isFinite(config.ativadoEm) ? config.ativadoEm : null);
  const corte = ativadoEm == null ? null : R.inicioDoDiaSP(R.dataSP(ativadoEm));
  if (corte != null) {
    for (const p of planos) for (const t of p.toques) {
      if (t.bloqueado_pela_recepcao || !(t.status === 'pendente' || t.status === 'bloqueado') || t.momento !== 'devida') continue;
      if (!(t.dueAt < corte)) continue;
      const ex = existentesPorChave.get(t.chave);
      if (!ativacao && ex && NA_FILA.has(ex.status)) continue;   // já estava na fila antes: segue valendo
      t.status = 'fora_da_janela'; t.bloqueio = null; t.motivo = 'anterior_a_ativacao';
    }
  }
  const r7 = _umaPorFamilia(planos, existentes, { config, agora, feriados });

  const toques = [];
  for (const p of planos) for (const t of p.toques) {
    t.acao = t.bloqueado_pela_recepcao ? 'manter' : _acao(t, existentesPorChave.get(t.chave));
    toques.push(t);
  }
  const conta = (f) => toques.filter(f).length;
  return {
    planos,
    toques,
    resumo: {
      contratos: planos.length,
      elegiveis: planos.filter((p) => p.elegivel).length,
      renovacoes: planos.filter((p) => p.motivo === 'renovacao').length,
      internos: planos.filter((p) => p.motivo === 'contato_interno').length,
      semTitular: planos.filter((p) => p.motivo === 'sem_titular').length,
      pendentesDevidas: conta((t) => t.status === 'pendente' && t.momento === 'devida'),
      pendentesFuturas: conta((t) => t.status === 'pendente' && t.momento === 'futura'),
      bloqueadas: conta((t) => t.status === 'bloqueado'),
      foraDaJanela: conta((t) => t.status === 'fora_da_janela'),
      agrupadas: r7.agrupadas,
      adiadas: r7.adiadas,
      alertasSemInicio: planos.filter((p) => p.alertaSemInicio).length,
      criar: conta((t) => t.acao === 'criar'),
      atualizar: conta((t) => t.acao === 'atualizar'),
    },
  };
}

module.exports = { FINAIS, nomeCurto, planejarContrato, planejarUnidade };
