'use strict';
//
// auto.js — ADR-050 (E17-05). Envio AUTOMÁTICO das mensagens de boas-vindas, só nas unidades que
// escolheram o modo "auto". Roda logo depois do planejamento da mesma rodada (boas-vindas-sweep), então
// só vê mensagens com prazo, R7 (uma por família por dia) e bloqueios recém-calculados.
//
// Travas, nesta ordem:
//   1. BOAS_VINDAS_PAUSA=1 → nada sai (pausa geral, sem deploy).
//   2. modo da unidade = 'auto' (padrão é 'desligado').
//   3. agora dentro do horário de atendimento da unidade (R5) — a rodada da noite não envia.
//   4. teto diário por unidade (BOAS_VINDAS_AUTO_CAP_DIA, padrão 60) e intervalo de 8–15 s entre envios.
//   5. só 'pendente' devida e sem erro anterior. Bloqueada (falta dado/arquivo) e a que já falhou uma vez
//      ficam para a recepção na aba Boas-vindas — nunca sai incompleta (§7).
//   6. falha de WhatsApp interrompe a unidade na rodada (instância fora do ar não vira rajada de tentativas).
//
// O envio é o MESMO da recepção (recepcao.enviar): reserva a linha antes de mandar (sem envio duplo com
// um clique da recepção ao mesmo tempo), manda o arquivo com legenda, e grava auto = true.
// Texto aprovado pela gestão não passa pela trava de tema da IA (ADR-050 §6.4): a tela avisa antes de ligar.
//
const { withTenant } = require('../db');
const logger = require('../logger');
const horario = require('../horario');
const R = require('../boasVindasRegua');
const recepcao = require('./recepcao');

const CAP_DIA = () => Number(process.env.BOAS_VINDAS_AUTO_CAP_DIA || 60);
const pausado = () => process.env.BOAS_VINDAS_PAUSA === '1';
const intervaloPadrao = () => 8000 + Math.floor(Math.random() * 7000);

const SQL_ELEGIVEIS = `
SELECT bt.id
  FROM lead_manager.boas_vindas_toque bt
  JOIN lead_manager.boas_vindas_etapa e ON e.tenant_id = bt.tenant_id AND e.id = bt.etapa_id
 WHERE bt.tenant_id = $1 AND bt.status = 'pendente' AND bt.erro IS NULL
   AND bt.due_at <= $2 AND e.ativo AND bt.phone IS NOT NULL
 ORDER BY bt.due_at, e.ordem, bt.id
 LIMIT $3`;

const SQL_ENVIADAS_HOJE = `
SELECT count(*)::int AS n FROM lead_manager.boas_vindas_toque
 WHERE tenant_id = $1 AND auto AND status = 'enviado' AND enviado_em >= $2`;

// Erro que não se resolve tentando de novo (texto com campo sem valor, arquivo sumiu): a mensagem fica
// para a recepção, com o motivo — e a próxima rodada não tenta de novo.
const SQL_MARCAR_ERRO = `
UPDATE lead_manager.boas_vindas_toque SET erro = $3, updated_at = now()
 WHERE tenant_id = $1 AND id = $2 AND status = 'pendente'`;

async function enviarAutomatico(tenantId, { config, agora = Date.now(), deps = {} } = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const intervalo = deps.intervalo || intervaloPadrao;
  const cap = deps.capDia != null ? deps.capDia : CAP_DIA();
  const resumo = { tenantId, enviados: 0, falhas: 0, retidos: 0 };

  if (pausado()) return { ...resumo, pulado: 'pausa_geral' };
  if (!config || config.modo !== 'auto') return { ...resumo, pulado: 'modo_nao_automatico' };
  if (!horario.dentroDoExpediente(config.horario, agora)) return { ...resumo, pulado: 'fora_do_horario_de_atendimento' };

  const inicioDoDia = new Date(R.inicioDoDiaSP(R.dataSP(agora))).toISOString();
  const jaHoje = await withTenant(tenantId, async (c) => (await c.query(SQL_ENVIADAS_HOJE, [tenantId, inicioDoDia])).rows[0].n);
  const restante = Math.max(0, cap - jaHoje);
  if (!restante) return { ...resumo, pulado: 'teto_diario' };

  const ids = await withTenant(tenantId, async (c) => (await c.query(SQL_ELEGIVEIS, [tenantId, new Date(agora).toISOString(), restante])).rows.map((r) => r.id));
  for (let i = 0; i < ids.length; i++) {
    if (pausado()) { resumo.pulado = 'pausa_geral'; break; }
    const r = await recepcao.enviar(tenantId, ids[i], { sender: 'boas-vindas-auto', auto: true, estados: ['pendente'] }, { inbox: deps.inbox });
    if (r && r.ok) {
      resumo.enviados += 1;
    } else if (r && r.status === 409) {
      continue;   // a recepção tratou no meio da rodada
    } else if (r && r.status === 422) {
      resumo.retidos += 1;
      await withTenant(tenantId, (c) => c.query(SQL_MARCAR_ERRO, [tenantId, ids[i], r.erro]));
      logger.warn('boas_vindas.auto.retida', { tenant_id: tenantId, toque: ids[i], erro: r.erro });
      continue;
    } else {
      resumo.falhas += 1;
      logger.warn('boas_vindas.auto.falha', { tenant_id: tenantId, toque: ids[i], erro: r && r.erro });
      break;      // WhatsApp fora: para a unidade nesta rodada
    }
    if (i < ids.length - 1) await sleep(intervalo());
  }
  return resumo;
}

module.exports = { enviarAutomatico, CAP_DIA, SQL_ELEGIVEIS };
