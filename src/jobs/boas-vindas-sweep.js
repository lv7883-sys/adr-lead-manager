'use strict';
//
// boas-vindas-sweep.js — ADR-050 (E17-02). Rotina diária da régua de boas-vindas, modo "AVISA".
//
// Para cada unidade ativa com o módulo ligado: carrega os contratos novos (últimos 60 dias), a régua
// da unidade, a agenda (pelo adaptador) e as mensagens já registradas; planeja (src/boasVindas/
// planejar.js) e grava as mensagens como pendentes/bloqueadas. NUNCA ENVIA: o envio automático é a
// E17-05. Enquanto a aba Boas-vindas da Caixa de Entrada (E17-03) não existir, ninguém vê o que foi
// gravado — dá para ligar e observar.
//
// --dry não grava nada e roda mesmo com o módulo desligado ou sem régua própria (usa o modelo):
// é a simulação.
// --ativar é o PRIMEIRO dia de uma unidade: o que já está devido é registrado como fora_da_janela
// (anterior_a_ativacao), sem ir para a recepção; só o que vence daqui para frente fica pendente (R6).
//
//   node src/jobs/boas-vindas-sweep.js [--dry] [--ativar] [--tenant=<uuid>]
//
// PORTÃO (ADR-050 regra 11 / ADR-051): hoje = tenants_active() (a mesma enumeração da renovação) +
// boas_vindas_modo <> 'desligado'. Quando plataforma.pode_rodar(unidade, 'boas_vindas') existir,
// troca-se `portaoPadrao` e nada mais.
//
// NÃO está agendado no cron (E17-02 aguarda aprovação da simulação).
//
const { pool, withTenant } = require('../db');
const logger = require('../logger');
const R = require('../boasVindasRegua');
const dados = require('../boasVindas/dados');
const agendaAdR = require('../boasVindas/agendaAcademiaDoRock');
const { planejarUnidade } = require('../boasVindas/planejar');

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

async function processarTenant(tenantId, opts = {}) {
  const {
    dry = false, ativacao = false, agora = Date.now(), feriados = [], fonte = agendaAdR, modeloPadrao = dados.MODELO_PADRAO,
  } = opts;
  const hoje = R.dataSP(agora);
  return withTenant(tenantId, async (c) => {
    const config = await dados.carregarConfig(c, tenantId);
    if (!dry && config.modo === 'desligado') return { tenantId, pulado: 'modo_desligado' };

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
    const plano = planejarUnidade({
      contratos, etapas, fatosPorConta: fatosPorConta(contratos, aulas, fonte, agora), fonteAgenda: disp.ok,
      config, agora, feriados, existentes, ativacao,
    });

    const gravacao = { criado: 0, atualizado: 0, sem_mudanca: 0 };
    if (!dry) {
      for (const t of plano.toques) {
        if (t.acao === 'manter') continue;
        gravacao[await dados.gravarToque(c, tenantId, t)] += 1;
      }
    }
    return {
      tenantId, dry, ativacao, modo: config.modo, origemRegua,
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
      saida.push(r);
      logger.info('boas_vindas.tenant', { tenant_id: t, dry: !!opts.dry, pulado: r.pulado || null, resumo: r.resumo || null, gravacao: r.gravacao || null });
    } catch (err) {
      logger.error('boas_vindas.tenant_error', { tenant_id: t, error: err.message });
      saida.push({ tenantId: t, erro: err.message });
    }
  }
  return saida;
}

module.exports = { processarTenant, runBoasVindasSweep, fatosPorConta, portaoPadrao, JANELA_DIAS };

if (require.main === module) {
  const dry = process.argv.includes('--dry');
  const ativacao = process.argv.includes('--ativar');
  const arg = process.argv.find((a) => a.startsWith('--tenant='));
  if (ativacao && !arg) { console.error('--ativar exige --tenant=<uuid> (ativação é por unidade)'); process.exit(2); }
  runBoasVindasSweep({ dry, ativacao, tenantId: arg ? arg.slice('--tenant='.length) : null })
    .then((r) => {
      for (const x of r) console.log(JSON.stringify({ tenantId: x.tenantId, pulado: x.pulado, erro: x.erro, resumo: x.resumo, gravacao: x.gravacao }));
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((e) => { logger.error('boas_vindas.fatal', { error: e.message }); process.exit(1); });
}
