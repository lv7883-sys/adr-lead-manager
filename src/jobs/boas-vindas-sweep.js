'use strict';
//
// boas-vindas-sweep.js — ADR-050 (E17-02/E17-05). Rotina da régua de boas-vindas.
//
// Para cada unidade ativa com o módulo ligado: carrega os contratos novos (últimos 60 dias), a régua
// da unidade, a agenda (pelo adaptador) e as mensagens já registradas; planeja (src/boasVindas/
// planejar.js) e grava as mensagens como pendentes/bloqueadas; abre e fecha os ALERTAS de cliente que
// não começou. Depois, FORA da transação, só nas unidades em modo "auto", envia o que está devido
// (src/boasVindas/auto.js). No modo "avisa" nada sai sozinho: a recepção envia pela aba Boas-vindas.
//
// ATIVAÇÃO (E17-05): automacao_config.boas_vindas_ativado_em marca quando a unidade saiu de 'desligado'
// (gravado pela tela; se estiver vazio, a primeira rodada grava). O que venceu antes disso vira
// fora_da_janela em toda rodada — nunca o atraso acumulado de uma vez.
//
// --dry não grava nada e roda mesmo com o módulo desligado ou sem régua própria (usa o modelo):
// é a simulação.
// --ativar grava AGORA como o instante da ativação da unidade (recomeça o corte); com --dry, só simula.
//
//   node src/jobs/boas-vindas-sweep.js [--dry] [--ativar] [--tenant=<uuid>]
//
// PORTÃO (ADR-050 regra 11 / ADR-051): hoje = tenants_active() (a mesma enumeração da renovação) +
// boas_vindas_modo <> 'desligado'. Quando plataforma.pode_rodar(unidade, 'boas_vindas') existir,
// troca-se `portaoPadrao` e nada mais.
//
// Cron: src/server.js, de hora em hora das 7h às 21h (SP). Pausa geral sem deploy: BOAS_VINDAS_PAUSA=1.
//
const { pool, withTenant } = require('../db');
const logger = require('../logger');
const R = require('../boasVindasRegua');
const dados = require('../boasVindas/dados');
const agendaAdR = require('../boasVindas/agendaAcademiaDoRock');
const { planejarUnidade } = require('../boasVindas/planejar');
const { enviarAutomatico } = require('../boasVindas/auto');

const JANELA_DIAS = R.LIMITES.TETO_DIAS;   // contrato que começou há mais que o teto não tem mais o que enviar

async function portaoPadrao(q) {
  return (await q.query('SELECT tenant_id FROM lead_manager.tenants_active()')).rows.map((r) => r.tenant_id);
}

// Fatos da agenda por contrato, pelo adaptador.
function fatosPorConta(contratos, aulas, fonte, agora) {
  const mapa = new Map();
  for (const ct of contratos) {
    const doContrato = fonte.aulasDoContrato(aulas, {
      idContrato: ct.contratoExt, idAluno: ct.beneficiario ? ct.beneficiario.alunoExt : null,
    });
    mapa.set(ct.accountId, fonte.fatosDoContrato(doContrato, { iniVigencia: ct.iniVigencia, agora }));
  }
  return mapa;
}

// Abre/atualiza o alerta de quem passou do prazo sem o 1º atendimento e fecha o de quem não precisa mais.
async function sincronizarAlertas(c, tenantId, plano, fatos, { agora, hoje }) {
  const r = { abertos: 0, atualizados: 0, fechados: 0 };
  const agoraMs = typeof agora === 'number' ? agora : Date.parse(agora);
  const abertosAntes = new Set(await dados.carregarAlertasAbertos(c, tenantId));
  const comAlerta = new Set();
  for (const p of plano.planos) {
    if (!p.elegivel || !p.alertaSemInicio) continue;
    comAlerta.add(p.accountId);
    const proximo = ((fatos.get(p.accountId) || {}).atendimentos || []).find((a) => a.inicio > agoraMs) || null;
    const res = await dados.gravarAlerta(c, tenantId, {
      accountId: p.accountId, iniVigencia: p.iniVigencia, dias: R.diasEntre(p.iniVigencia, hoje),
      phone: p.destinatario && p.destinatario.telefone, destinatarioNome: p.destinatario && p.destinatario.destinatarioNome,
      clienteNome: p.clienteNome, proximoAtendimento: proximo && proximo.inicio,
    });
    if (res === 'criado') r.abertos += 1; else r.atualizados += 1;
  }
  for (const accountId of abertosAntes) {
    if (comAlerta.has(accountId)) continue;
    const p = plano.planos.find((x) => x.accountId === accountId);
    const motivo = !p || !p.elegivel ? 'fora_da_janela' : p.primeiroAtendimento ? 'comecou' : 'abaixo_do_prazo';
    if (await dados.fecharAlerta(c, tenantId, accountId, motivo)) r.fechados += 1;
  }
  return r;
}

async function processarTenant(tenantId, opts = {}) {
  const {
    dry = false, ativacao = false, agora = Date.now(), feriados = [], fonte = agendaAdR, modeloPadrao = dados.MODELO_PADRAO,
  } = opts;
  const hoje = R.dataSP(agora);
  return withTenant(tenantId, async (c) => {
    const config = await dados.carregarConfig(c, tenantId);
    if (!dry && config.modo === 'desligado') return { tenantId, pulado: 'modo_desligado' };
    if (!dry && (ativacao || config.ativadoEm == null)) {
      await c.query('UPDATE lead_manager.automacao_config SET boas_vindas_ativado_em = $2 WHERE tenant_id = $1',
        [tenantId, new Date(agora).toISOString()]);
      config.ativadoEm = typeof agora === 'number' ? agora : Date.parse(agora);
    }

    let etapas = await dados.carregarEtapas(c, tenantId);
    let origemRegua = 'unidade';
    if (!etapas.length) {
      if (!dry) return { tenantId, pulado: 'sem_regua' };
      etapas = await dados.carregarModelo(c, config.modelo || modeloPadrao);
      origemRegua = `modelo:${config.modelo || modeloPadrao}`;
    }

    const disp = await fonte.disponibilidade(c, tenantId);
    const validacao = R.validarRegua(etapas, {
      ancorasDisponiveis: disp.ok ? fonte.ANCORAS : ['inicio_contrato'],
      variaveisLivres: Object.keys(config.variaveis || {}),
    });
    if (!dry && !validacao.ok) {
      logger.warn('boas_vindas.regua_invalida', { tenant_id: tenantId, erros: validacao.erros });
      return { tenantId, pulado: 'regua_invalida', erros: validacao.erros };
    }

    const contratos = await dados.carregarContratos(c, tenantId, { hoje, janelaDias: JANELA_DIAS });
    const aulas = disp.ok
      ? await fonte.carregarAulas(c, disp.franquiaId, { desde: R.somarDias(hoje, -JANELA_DIAS), ate: R.somarDias(hoje, 7) })
      : [];
    const existentes = await dados.carregarToques(c, tenantId, contratos.map((x) => x.accountId));
    const fatos = fatosPorConta(contratos, aulas, fonte, agora);
    const plano = planejarUnidade({
      contratos, etapas, fatosPorConta: fatos, fonteAgenda: disp.ok, config, agora, feriados, existentes, ativacao,
    });

    const gravacao = { criado: 0, atualizado: 0, sem_mudanca: 0 };
    const alertas = { abertos: 0, atualizados: 0, fechados: 0 };
    if (!dry) {
      for (const t of plano.toques) {
        if (t.acao === 'manter') continue;
        gravacao[await dados.gravarToque(c, tenantId, t)] += 1;
      }
      // Alerta de cliente que não começou: só com presença integrada (sem agenda não há como saber).
      if (disp.ok) Object.assign(alertas, await sincronizarAlertas(c, tenantId, plano, fatos, { agora, hoje }));
    }
    return {
      tenantId, dry, ativacao, modo: config.modo, config, origemRegua, alertas,
      agenda: disp.ok ? fonte.NOME : null, motivoSemAgenda: disp.ok ? null : disp.motivo,
      aulasLidas: aulas.length, reguaValida: validacao.ok, errosRegua: validacao.erros,
      resumo: plano.resumo, gravacao, plano,
    };
  });
}

async function runBoasVindasSweep(opts = {}) {
  const q = opts.pool || pool;
  const tenants = opts.tenantId ? [opts.tenantId] : await (opts.portao || portaoPadrao)(q);
  const saida = [];
  for (const t of tenants) {
    try {
      const r = await processarTenant(t, opts);
      // Envio automático FORA da transação do planejamento (o intervalo entre envios não segura conexão).
      if (!opts.dry && !r.pulado && r.config && r.config.modo === 'auto') {
        r.auto = await enviarAutomatico(t, { config: r.config, agora: opts.agora, deps: opts.autoDeps || {} });
      }
      saida.push(r);
      logger.info('boas_vindas.tenant', { tenant_id: t, dry: !!opts.dry, pulado: r.pulado || null, resumo: r.resumo || null, gravacao: r.gravacao || null, alertas: r.alertas || null, auto: r.auto || null });
    } catch (err) {
      logger.error('boas_vindas.tenant_error', { tenant_id: t, error: err.message });
      saida.push({ tenantId: t, erro: err.message });
    }
  }
  return saida;
}

module.exports = { processarTenant, runBoasVindasSweep, sincronizarAlertas, fatosPorConta, portaoPadrao, JANELA_DIAS };

if (require.main === module) {
  const dry = process.argv.includes('--dry');
  const ativacao = process.argv.includes('--ativar');
  const arg = process.argv.find((a) => a.startsWith('--tenant='));
  if (ativacao && !arg) { console.error('--ativar exige --tenant=<uuid> (ativação é por unidade)'); process.exit(2); }
  runBoasVindasSweep({ dry, ativacao, tenantId: arg ? arg.slice('--tenant='.length) : null })
    .then((r) => {
      for (const x of r) console.log(JSON.stringify({ tenantId: x.tenantId, pulado: x.pulado, erro: x.erro, resumo: x.resumo, gravacao: x.gravacao, alertas: x.alertas, auto: x.auto }));
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((e) => { logger.error('boas_vindas.fatal', { error: e.message }); process.exit(1); });
}
