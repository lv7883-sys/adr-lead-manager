'use strict';
//
// interessesDaConversa.js — passo 2 do modelo contato↔oportunidade (25/09/2026).
// Descobre, LENDO A CONVERSA, quem quer qual instrumento PARA QUEM, e grava em lead_interesse.
//
// ⚠ O CAMINHO SEGURO, escolhido pelo Leo entre duas opções que apresentei. A regra dele: "a
// identificação de leads já funciona muito bem, com o gate, IA, etc. e isso não pode em hipótese
// nenhuma se perder". Logo:
//   • chamada de IA PRÓPRIA (gemini.extrairInteresses), separada da que decide "é lead" — o
//     classificador não lê nada daqui e não muda;
//   • roda em JOB, em lote, FORA do webhook e do engine. Nenhum arquivo do pipeline é tocado;
//   • só ESCREVE em lead_interesse. Nunca em leads, lead_eventos, stage_autoapply_log;
//   • se este job morrer, quebrar ou devolver bobagem, o funil segue idêntico.
//
// POR QUE ELE EXISTE: medido em 25/09, das 29 famílias com 2+ filhos matriculados E lead no LM,
// apenas 1 tinha mais de um interesse registrado e 25 não tinham NENHUM. O passo 1 (fichas da
// Extranet) não as alcança porque elas chegaram pelo WhatsApp — a Extranet cobre 184 dos 748
// leads. O "instrumento para mim, outro para o filho" vive no texto da conversa, e só ali.
//
// O QUE NÃO FAZ: não deduz beneficiário por nome parecido (há homônimos reais na base e dois leads
// chamados "Carolina"); não afirma `para_si` quando a conversa não diz (fica NULL = não sei, migr
// 181); não apaga nem altera interesse vindo de ficha da Extranet (fonte='extranet_lead').
//
// IDEMPOTENTE por (lead, beneficiário, instrumento) normalizados: rodar de novo não duplica, só
// atualiza `ultimo_visto_em`. Conversa que ganha mensagem nova pode revelar interesse novo — por
// isso o job pode rodar periodicamente sem estragar o que já existe.
//
const { withTenant } = require('../db');
const logger = require('../logger');
const gemini = require('../gemini');
const { loadRealHistory } = require('../engine');   // só LEITURA de histórico; nada é reprocessado
const { comUnidade } = require('../plataforma/contexto');   // custo de IA tem dono (senão vira órfão)

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// FUNDE NOMES QUASE IGUAIS DENTRO DA MESMA CONVERSA. Na 1ª amostra a IA devolveu "Lucas" e "Luca"
// na mesma conversa — quase certamente a mesma criança, escrita de dois jeitos pela mãe. Duas
// linhas ali seriam duas pessoas inventadas.
//
// ⚠ O ESCOPO É O QUE TORNA ISTO SEGURO: só funde DENTRO DA MESMA CONVERSA, onde "Luca" e "Lucas"
// ditos pela mesma pessoa quase sempre são o mesmo filho. NUNCA entre conversas — lá, nome
// parecido é homônimo (há dois leads chamados "Carolina" nesta base), e fundir seria o erro
// invisível que a semana inteira ensinou a evitar. Critério conservador: um nome é prefixo do
// outro e a diferença é de no máximo 2 letras. "Ana" e "Antonio" não fundem (diferença 4).
function _fundirNomesParecidos(itens) {
  const out = [];
  for (const it of itens) {
    const n = norm(it.beneficiario);
    const irmao = n && out.find((o) => {
      const m = norm(o.beneficiario);
      if (!m) return false;
      const [curto, longo] = m.length <= n.length ? [m, n] : [n, m];
      return longo.startsWith(curto) && longo.length - curto.length <= 2;
    });
    if (irmao) {
      // fica com a grafia MAIS LONGA (mais informativa) e acumula o instrumento como item próprio
      if (norm(it.beneficiario).length > norm(irmao.beneficiario).length) irmao.beneficiario = it.beneficiario;
      if (it.instrumento && norm(it.instrumento) !== norm(irmao.instrumento)) out.push({ ...it, beneficiario: irmao.beneficiario });
      continue;
    }
    out.push({ ...it });
  }
  // depois de fundir as grafias, sobram combinações idênticas ("Lucas|bateria" duas vezes, uma
  // delas vinda de "Luca"): colapsa. O _gravar também protege no banco, mas aqui os contadores
  // do job passam a dizer a verdade.
  const vistos = new Set();
  return out.filter((x) => {
    const k = norm(x.beneficiario) + '|' + norm(x.instrumento);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

// ⚠ DUAS TRAVAS CONTRA CONVERSA DE TRABALHO, medidas na 1ª rodada real (50 conversas, 25/09):
// 116 interesses extraídos, e MAIS DA METADE era ruído operacional. Quem fala com a escola sobre
// MUITOS alunos não é uma família — é a equipe. Os campeões eram Daniele, Leo Vecchi e Allan
// Azevedo, com 11 "interesses" cada: conversas sobre alunos da casa, lidas como pedidos de aula.
//
//   TRAVA 1 — CONTATO INTERNO só vale PARA SI. Medido: 4 internos geraram 39 interesses, dos quais
//     32 eram "para outra pessoa" (alunos que eles administram) e 6 eram "para si" — e esses 6 são
//     VERDADE: o Leo faz aula de canto e violão, o Allan de violão. Então não se exclui o interno
//     (ele PODE ser lead, palavras do Leo: "todos podem ser novos leads, eu mesmo estou fazendo
//     aula de canto") — exclui-se o que ele diz sobre TERCEIROS.
//   TRAVA 2 — TETO DE BENEFICIÁRIOS. Conversa que produz 5+ pessoas distintas é lista de alunos,
//     não família: 7 conversas assim concentravam 67 dos 116 interesses. Uma família real tem 2 ou
//     3 filhos. Descarta a conversa inteira e CONTA no stats (conversa_operacional) — ruído
//     silencioso é o que faz ninguém confiar no dado.
const MAX_BENEFICIARIOS = 5;

// Leads candidatos: têm conversa e ainda não foram lidos por este job (ou têm mensagem mais nova
// que a última leitura). Não filtra por status: um interesse existe mesmo em lead descartado —
// e registrar não muda decisão nenhuma. Marca se o telefone é de CONTATO INTERNO (trava 1).
const SQL_CANDIDATOS = `
  SELECT l.id AS lead_id, cv.id AS conversation_id,
         regexp_replace(cv.external_id, '[^0-9]', '', 'g') AS ident,
         max(m.received_at) AS ultima_msg,
         (SELECT max(i.ultimo_visto_em) FROM lead_manager.lead_interesse i
           WHERE i.lead_id = l.id AND i.fonte = 'conversa') AS lido_ate,
         EXISTS (SELECT 1 FROM lead_manager.internal_contacts ic
                  WHERE ic.tenant_id = l.tenant_id
                    AND lead_manager.br_phone_key(ic.phone) = lead_manager.br_phone_key(l.phone)) AS interno
    FROM lead_manager.leads l
    JOIN lead_manager.conversations cv
         ON cv.tenant_id = l.tenant_id
        AND lead_manager.br_phone_key(cv.external_id) = lead_manager.br_phone_key(l.phone)
    JOIN lead_manager.messages m ON m.conversation_id = cv.id AND m.role = 'USER'
   WHERE l.tenant_id = $1 AND l.phone IS NOT NULL
   GROUP BY l.id, cv.id, cv.external_id
  HAVING (SELECT max(i.ultimo_visto_em) FROM lead_manager.lead_interesse i
           WHERE i.lead_id = l.id AND i.fonte = 'conversa') IS NULL
      OR max(m.received_at) > (SELECT max(i.ultimo_visto_em) FROM lead_manager.lead_interesse i
           WHERE i.lead_id = l.id AND i.fonte = 'conversa')
   ORDER BY max(m.received_at) DESC
   LIMIT $2`;

// Grava um interesse da conversa. Idempotente por (lead, beneficiário, instrumento) normalizados —
// não há UNIQUE no banco para isso de propósito (a chave natural é texto livre e mutável), então a
// deduplicação é feita aqui, na leitura.
async function _gravar(c, tenantId, leadId, item) {
  const ja = await c.query(
    `SELECT id FROM lead_manager.lead_interesse
      WHERE tenant_id=$1 AND lead_id=$2 AND fonte='conversa'
        AND coalesce($3::text,'') = coalesce(regexp_replace(lower(coalesce(beneficiario_nome,'')), '\\s+', ' ', 'g'),'')
        AND coalesce($4::text,'') = coalesce(regexp_replace(lower(coalesce(curso,'')), '\\s+', ' ', 'g'),'')
      LIMIT 1`,
    [tenantId, leadId, item.beneficiario ? norm(item.beneficiario) : null,
     item.instrumento ? norm(item.instrumento) : null]);
  if (ja.rows[0]) {
    await c.query('UPDATE lead_manager.lead_interesse SET ultimo_visto_em=now(), updated_at=now() WHERE id=$1',
      [ja.rows[0].id]);
    return false;
  }
  // O CHECK da 180/181 exige coerência: para_si=false só com nome; NULL só sem nome.
  const paraSi = item.beneficiario ? false : (item.para_si === true ? true : null);
  await c.query(
    `INSERT INTO lead_manager.lead_interesse
       (tenant_id, lead_id, para_si, beneficiario_nome, curso, fonte)
     VALUES ($1,$2,$3,$4,$5,'conversa')`,
    [tenantId, leadId, paraSi, item.beneficiario || null, item.instrumento || null]);
  return true;
}

// ⚠ TODO o corpo roda dentro de comUnidade: sem isso, cada chamada de IA vira "custo órfão" (o
// próprio ia.js avisa no log) e a unidade dona não é cobrada. Flagrado na 1ª amostra de 25/09,
// com 5 órfãos em 5 leituras — corrigido antes de rodar em escala, não depois.
async function run(tenantId, opcoes = {}) {
  return comUnidade(tenantId, { modulo: 'LEADS' }, () => _run(tenantId, opcoes));
}

async function _run(tenantId, { limite = 50, dryRun = false } = {}) {
  const cands = await withTenant(tenantId, (c) => c.query(SQL_CANDIDATOS, [tenantId, limite]).then((r) => r.rows));
  const stats = { candidatos: cands.length, lidos: 0, novos: 0, revistos: 0, sem_interesse: 0,
    conversa_operacional: 0, interno_so_para_si: 0, erros: 0, amostra: [] };
  for (const cand of cands) {
    let itens;
    try {
      const history = await loadRealHistory(tenantId, {
        conversationId: cand.conversation_id, ident: cand.ident, leadId: cand.lead_id });
      if (!history || !history.length) { stats.sem_interesse++; continue; }
      itens = _fundirNomesParecidos(await gemini.extrairInteresses({ conversation: history }));
      stats.lidos++;
    } catch (e) {
      stats.erros++;
      logger.warn('interesses_conversa.falha', { tenant_id: tenantId, lead_id: cand.lead_id, error: e.message });
      continue;
    }
    // TRAVA 2 — muitos beneficiários distintos = lista de alunos, não família. Descarta a conversa
    // inteira, e o contador diz que descartou (ruído silencioso é o que mata a confiança no dado).
    const distintos = new Set(itens.filter((x) => x.beneficiario).map((x) => norm(x.beneficiario)));
    if (distintos.size >= MAX_BENEFICIARIOS) { stats.conversa_operacional++; continue; }
    // TRAVA 1 — de contato interno só vale o que é PARA SI; o que ele diz de terceiros é trabalho.
    if (cand.interno) {
      const antes = itens.length;
      itens = itens.filter((x) => x.para_si === true && !x.beneficiario);
      if (antes !== itens.length) stats.interno_so_para_si++;
    }
    if (!itens.length) { stats.sem_interesse++; continue; }
    if (stats.amostra.length < 8) stats.amostra.push({ lead_id: cand.lead_id, itens });
    if (dryRun) continue;
    await withTenant(tenantId, async (c) => {
      for (const it of itens) (await _gravar(c, tenantId, cand.lead_id, it)) ? stats.novos++ : stats.revistos++;
    });
  }
  logger.info('interesses_conversa.ok', { tenant_id: tenantId, ...stats, amostra: undefined });
  return stats;
}

module.exports = { run, SQL_CANDIDATOS };

if (require.main === module) {
  const tid = process.argv[2];
  const lim = Number(process.argv[3] || 50);
  const dry = process.argv.includes('--dry');
  if (!tid) { console.error('uso: node src/cadastro/interessesDaConversa.js <tenantId> [limite] [--dry]'); process.exit(1); }
  run(tid, { limite: lim, dryRun: dry })
    .then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(0); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
