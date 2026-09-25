'use strict';
//
// fechaPorContrato.js — FECHAMENTO AUTOMÁTICO DO CARD QUANDO A EXTRANET REGISTRA CONTRATO.
//
// Decisão do Leo (23-25/09): "tem que olhar na extranet e se tem contrato o sistema fecha como
// matriculado" e "a Extranet é fonte confiável 100% de que o lead virou matrícula e isso a gente
// precisa usar no funil". Esta é a automação do que a migr 178 fez à mão nos 11 casos que ele viu.
//
// POR QUE ISTO EXISTE (o defeito que ele flagrou): a recepção matricula e NÃO marca 'Ganhou' na
// ficha do lead na Extranet — medido: nenhuma das 11 fichas estava marcada. Como o sync de leads
// fecha pela SITUAÇÃO da ficha, o card ficava aberto para sempre com a pessoa já pagando. O
// contrato é o fato que não depende de ninguém lembrar de clicar.
//
// RÉGUA (a mesma da 178, validada com o ADR-BI em 23/09):
//   fecha quem está em ETAPA DE TRABALHO e tem contrato cuja ini_vigencia é >= a data de criação
//   do lead. O ">=" é o que separa CONVERSÃO de quem JÁ ERA CLIENTE antes de virar lead — sem ele,
//   marcaríamos como matrícula do funil gente que já pagava (é o que o contract_convert fazia e
//   motivou o 'off' de 18/09).
//
// QUATRO GUARDAS, cada uma com um incidente por trás:
//   1. DESFECHO EXISTENTE é intocável — decisão registrada (humana ou não) não é sobrescrita.
//   2. SÓ ETAPA DE TRABALHO — NOT_LEAD/REVIEW_QUEUE ficam de fora por decisão explícita do Leo:
//      "quando o Regente começou eles já estavam matriculados, ou seja, não eram leads mesmo".
//      São 104 registros que não se toca.
//   3. CONTATO INTERNO NÃO ENTRA — casando por br_phone_key em internal_contacts. Sem isto,
//      ligar marcaria Késsia (recepcionista) como matriculada e Daniele (gestora) como cliente.
//   4. REVERSÃO RESPEITADA — quem foi revertido no Monitor (suggested_stage_dismissed='convertido')
//      não é re-fechado; senão o job desfaz a decisão da recepção no dia seguinte, em loop.
//
// O QUE NÃO FAZ, de propósito: não marca ninguém como 'cliente' (o terminal do pré-existente), não
// mexe em NOT_LEAD, não lê a situação da ficha (o contrato basta), não toca no gate nem na régua
// de etapa. Nada aqui altera como um lead é IDENTIFICADO — só registra um fato que já aconteceu.
//
// desfecho_em = ini_vigencia do CONTRATO (não now()), para o funil contar no mês certo — o ADR-BI
// confirmou que essa é a data do fato do nosso lado, mesmo que o painel deles agrupe por
// mesReferencia (~8% caem em mês diferente; divergência conhecida e documentada).
//
// Reversível card a card no Monitor (stage_autoapply_log, source='contract_match').
// Idempotente: quem já tem desfecho sai do universo na execução seguinte.
//
const { withTenant } = require('../db');
const logger = require('../logger');

// Universo elegível + a matrícula que justifica o fechamento. SELECT puro — nada escreve aqui,
// e é exatamente o que o modo simulação mostra.
const SQL_ELEGIVEIS = `
  SELECT l.id, l.name, l.status AS status_antes, l.created_at,
         max(sa.ini_vigencia) AS matricula,
         (SELECT string_agg(DISTINCT p2.display_name || ' (' || coalesce(sa2.servico_label,'?') || ')', ' / ')
            FROM lead_manager.contact_point cp2
            JOIN lead_manager.account_member am2 ON am2.person_id = cp2.person_id AND am2.bond = 'beneficiario'
            JOIN lead_manager.service_account sa2 ON sa2.id = am2.account_id AND sa2.fonte_ausente_em IS NULL
            JOIN lead_manager.person p2 ON p2.id = am2.person_id
           WHERE cp2.kind = 'phone'
             AND lead_manager.br_phone_key(cp2.value_raw) = lead_manager.br_phone_key(l.phone)
             AND sa2.ini_vigencia >= l.created_at::date) AS quem_matriculou
    FROM lead_manager.leads l
    JOIN lead_manager.contact_point cp ON cp.kind = 'phone'
         AND lead_manager.br_phone_key(cp.value_raw) = lead_manager.br_phone_key(l.phone)
    JOIN lead_manager.account_member am ON am.person_id = cp.person_id
    JOIN lead_manager.service_account sa ON sa.id = am.account_id AND sa.fonte_ausente_em IS NULL
   WHERE l.tenant_id = $1
     AND l.desfecho IS NULL                                            -- guarda 1
     AND l.status NOT IN ('NOT_LEAD','REVIEW_QUEUE','PENDING_CLASSIFICATION','OPTED_OUT','CONVERTED')  -- guarda 2
     AND NOT EXISTS (                                                   -- guarda 3
           SELECT 1 FROM lead_manager.internal_contacts ic
            WHERE ic.tenant_id = l.tenant_id
              AND lead_manager.br_phone_key(ic.phone) = lead_manager.br_phone_key(l.phone))
     AND coalesce(l.suggested_stage_dismissed,'') <> 'convertido'       -- guarda 4
     AND sa.ini_vigencia >= l.created_at::date                          -- a régua
   GROUP BY l.id, l.name, l.status, l.created_at
   ORDER BY max(sa.ini_vigencia)`;

// SIMULAÇÃO: quem seria fechado, sem tocar em nada. É o portão antes de qualquer execução.
async function simular(c, { tenantId } = {}) {
  const r = await c.query(SQL_ELEGIVEIS, [tenantId]);
  return r.rows.map((x) => ({
    lead_id: x.id, nome: x.name, status_antes: x.status_antes,
    matricula: x.matricula, quem_matriculou: x.quem_matriculou,
    gap_dias: Math.round((new Date(x.matricula) - new Date(x.created_at)) / 86400000),
  }));
}

// Fecha um lead. Guarda o estado anterior no log (reverter no Monitor restaura exato).
async function _fechar(c, tenantId, item) {
  const l = (await c.query(
    'SELECT status, desfecho, desfecho_em FROM lead_manager.leads WHERE id=$1', [item.lead_id])).rows[0];
  if (!l || l.desfecho != null) return false;   // corrida: alguém decidiu antes
  await c.query(
    `UPDATE lead_manager.leads
        SET status='CONVERTED', desfecho='matriculado', desfecho_source='extranet',
            desfecho_em=$2::timestamptz,
            suggested_stage=NULL, stage_reasoning=NULL, stage_suggested_at=NULL, updated_at=now()
      WHERE id=$1`, [item.lead_id, item.matricula]);
  const conteudo = 'Fechado como matriculado: a Extranet registra contrato em '
    + String(item.matricula).slice(0, 10).split('-').reverse().join('/')
    + (item.quem_matriculou ? ' (' + item.quem_matriculou + ')' : '')
    + ', posterior ao primeiro contato.';
  const ev = (await c.query(
    `INSERT INTO lead_manager.lead_eventos (tenant_id, lead_id, tipo, autor, conteudo, etapa_key)
     VALUES ($1,$2,'mudanca_etapa','contrato_auto',$3,'convertido') RETURNING id`,
    [tenantId, item.lead_id, conteudo])).rows[0];
  await c.query(
    `INSERT INTO lead_manager.stage_autoapply_log
       (tenant_id, lead_id, from_stage, to_stage, reasoning, source,
        prior_status, prior_desfecho, prior_desfecho_em, evento_id)
     VALUES ($1,$2,$3,'convertido',$4,'contract_match',$5,NULL,NULL,$6)`,
    [tenantId, item.lead_id,
     item.status_antes === 'EXPERIMENTAL_AGENDADA' ? 'experimental'
       : item.status_antes === 'QUALIFIED' ? 'qualificado' : 'qualificando',
     conteudo, item.status_antes, ev.id]);
  return true;
}

// dryRun=true (default) → só lista. Explicitamente falso → aplica.
async function run(tenantId, { dryRun = true } = {}) {
  return withTenant(tenantId, async (c) => {
    const elegiveis = await simular(c, { tenantId });
    if (dryRun) return { dry_run: true, elegiveis: elegiveis.length, itens: elegiveis };
    let fechados = 0;
    for (const item of elegiveis) if (await _fechar(c, tenantId, item)) fechados++;
    logger.info('fecha_por_contrato.ok', { tenant_id: tenantId, elegiveis: elegiveis.length, fechados });
    return { dry_run: false, elegiveis: elegiveis.length, fechados, itens: elegiveis };
  });
}

module.exports = { simular, run, SQL_ELEGIVEIS };

if (require.main === module) {
  const tid = process.argv[2];
  const aplicar = process.argv.includes('--aplicar');
  if (!tid) { console.error('uso: node src/cadastro/fechaPorContrato.js <tenantId> [--aplicar]'); process.exit(1); }
  run(tid, { dryRun: !aplicar })
    .then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(0); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
