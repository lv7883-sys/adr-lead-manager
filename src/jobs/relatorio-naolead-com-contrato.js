'use strict';
//
// relatorio-naolead-com-contrato.js — SÓ LEITURA. Lista quem está fora do funil como "não é lead"
// e TEM contrato começado DEPOIS de chegar: conversão real que ninguém vai contar.
//
// POR QUE EXISTE (01/10/2026)
//   O fechamento automático por contrato (cadastro/fechaPorContrato) não alcança NOT_LEAD/
//   REVIEW_QUEUE — guarda 2, decisão do Leo: "quando o Regente começou eles já estavam
//   matriculados, ou seja, não eram leads mesmo". A premissa é boa: medido em 26/09/2026, vale em
//   131 de 135 NOT_LEAD com contrato. O problema são as EXCEÇÕES: as 4 que sobraram só apareceram
//   porque alguém foi procurar à mão (Carla Manzoni, Ronaldo, Nínive — devolvidos pela migr 182 —
//   e a Késsia, que era teste do modelo de contrato). Sem este relatório, a próxima exceção fica
//   invisível pelo mesmo caminho: ninguém suspeita de um número que não existe.
//
// NÃO ESCREVE NADA, de propósito. Afrouxar a guarda traria de volta os 131 que realmente já eram
// alunos; o certo é a exceção ser VISÍVEL e a decisão ser de quem conhece o caso.
//
//   docker exec adr-lead-manager node /app/src/jobs/relatorio-naolead-com-contrato.js
//   (--json para saída de máquina)
//
// Cron: deploy/crontab.relatorio-naolead.txt (semanal). alert:true no log quando houver caso —
// o plantão já destaca linha com alert.
//
const { withTenant } = require('../db');
const logger = require('../logger');

const TENANT = process.env.VALIDA_TENANT || 'ed731a58-62e5-45ad-acba-a5502ff39e92';

// Mesma propriedade da migr 182 e do fechaPorContrato: contrato cuja ini_vigencia é >= a data de
// criação do lead (o ">=" separa conversão de quem já era aluno), E nenhum contrato anterior a ela.
// Contato interno fora (a guarda 3 do fechaPorContrato existe porque ligar marcaria a recepção).
const SQL = `
  SELECT l.id, l.name, (l.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS criado,
         l.status, l.review_result,
         min(sa.ini_vigencia) FILTER (WHERE sa.ini_vigencia >= l.created_at::date) AS matricula,
         string_agg(DISTINCT p.display_name || ' (' || coalesce(sa.servico_label, 'curso') || ' '
                    || to_char(sa.ini_vigencia, 'DD/MM') || ')', ' + ')
           FILTER (WHERE sa.ini_vigencia >= l.created_at::date) AS quem_matriculou,
         (SELECT count(*) FROM lead_manager.messages m
            JOIN lead_manager.conversations cv ON cv.id = m.conversation_id
           WHERE regexp_replace(cv.external_id, '[^0-9]', '', 'g')
               = regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g')) AS msgs
    FROM lead_manager.leads l
    JOIN lead_manager.contact_point cp
         ON cp.kind = 'phone' AND cp.br_key = lead_manager.br_phone_key(l.phone) AND cp.br_key <> ''
    JOIN lead_manager.account_member am ON am.person_id = cp.person_id
    JOIN lead_manager.service_account sa ON sa.id = am.account_id AND sa.fonte_ausente_em IS NULL
    JOIN lead_manager.account_member ben ON ben.account_id = am.account_id AND ben.bond = 'beneficiario'
    JOIN lead_manager.person p ON p.id = ben.person_id
   WHERE l.tenant_id = $1
     AND l.status IN ('NOT_LEAD', 'REVIEW_QUEUE')
     AND l.desfecho IS NULL
     -- caso JÁ DECIDIDO como "não é captação" não volta a alertar: usa a MESMA marca que a
     -- guarda 4 do fechaPorContrato respeita (suggested_stage_dismissed), em vez de inventar
     -- uma lista no código. Alerta que toca sempre é alerta que ninguém lê.
     AND coalesce(l.suggested_stage_dismissed, '') <> 'convertido'
     AND NOT EXISTS (SELECT 1 FROM lead_manager.internal_contacts ic
                      WHERE ic.tenant_id = l.tenant_id
                        AND lead_manager.br_phone_key(ic.phone) = lead_manager.br_phone_key(l.phone))
   GROUP BY l.id, l.name, l.created_at, l.status, l.review_result
  HAVING min(sa.ini_vigencia) FILTER (WHERE sa.ini_vigencia >= l.created_at::date) IS NOT NULL
     AND min(sa.ini_vigencia) FILTER (WHERE sa.ini_vigencia <  l.created_at::date) IS NULL
   ORDER BY 6`;

async function listar(tenantId = TENANT) {
  return withTenant(tenantId, async (c) => (await c.query(SQL, [tenantId])).rows);
}

async function main() {
  const json = process.argv.includes('--json');
  const casos = await listar();
  logger[casos.length ? 'error' : 'info']('naolead_com_contrato.relatorio', {
    alert: casos.length > 0, tenant_id: TENANT, casos: casos.length,
    nomes: casos.map((x) => x.name),
  });
  if (json) { console.log(JSON.stringify(casos, null, 2)); return casos.length; }
  if (!casos.length) {
    console.log('Nenhum caso: todo NOT_LEAD com contrato já era aluno antes de virar lead.');
    return 0;
  }
  console.log(`${casos.length} lead(s) fora do funil COM matrícula posterior ao primeiro contato:\n`);
  for (const x of casos) {
    console.log(`  ${x.name} — lead ${x.criado.toISOString().slice(0, 10)}, contrato ${String(x.matricula).slice(0, 10)}`);
    console.log(`    matriculou: ${x.quem_matriculou || '?'} · ${x.msgs} mensagens · ${x.review_result || 'descarte do classificador'}`);
    console.log(`    id: ${x.id}`);
  }
  console.log('\nNada foi escrito. Cada caso é uma decisão: devolver ao funil (molde da migr 182)');
  console.log('ou confirmar que não é captação (foi o caso da Késsia, teste do modelo de contrato).');
  return casos.length;
}

module.exports = { listar, SQL };

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    logger.error('naolead_com_contrato.fatal', { error: e.message });
    process.exit(1);
  });
}
