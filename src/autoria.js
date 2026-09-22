'use strict';

// Autoria real nas ações de confirmar/descartar (decisão Leo 22/09/2026, item 3 — conserto
// estrutural da frente do Scheduler): o dashboard manda `by_name` (nome do usuário logado)
// no corpo — mesma convenção do /desfecho e /automacao. Sem o campo, cai no papel do token
// ('SERVICE'), que segue significando "chamador de serviço sem identidade" — NUNCA "a máquina
// decidiu": automação interna não passa pelas rotas HTTP (grava 'ia_auto'/'extranet_auto'/NULL
// direto). Assim review_by distingue pessoa (nome próprio) × serviço × automação.
//
// ATENÇÃO (pedido da frente da Extranet): um by_name com valor RESERVADO fabricaria um
// "humano" ou uma "máquina" falsos e envenenaria exatamente essa distinção — e cada nome
// próprio novo ATIVA o latch humano do contractConvert (`review_by <> 'SERVICE'`), que hoje
// está dormente por falta de nomes na base. Por isso valores reservados são rejeitados e
// caem no papel do token, como se o campo não tivesse vindo.
const RESERVADOS = /^(service|ia_auto|extranet_auto|migracao-.*)$/i;

function autorHumano(req) {
  const v = typeof req.body?.by_name === 'string' ? req.body.by_name.trim().slice(0, 80) : '';
  if (!v || RESERVADOS.test(v)) return req.tenantRole;
  return v;
}

module.exports = { autorHumano, RESERVADOS };
