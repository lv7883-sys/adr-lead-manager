'use strict';
//
// semAtendimentoHumano.js — "QUANTOS LEADS NINGUÉM DA CASA OLHOU AINDA?"
//
// É o número do ícone do Regente no celular (badge). Decisão D1 do Leo, 16/11/2026, em
// docs/proposta-aviso-lead-novo.md: entre as duas contas possíveis, vale a que **só desce quando
// uma PESSOA responde** — a resposta automática da Janis não tira o lead da conta.
//
// ─── POR QUE ISTO NÃO É A RÉGUA DA BOLA, E NÃO PODE SER ────────────────────────────────────────
//
// A tentação óbvia era reaproveitar src/bola.js passando "última saída HUMANA" no lugar de
// "última saída" — ela recebe `lastOut` de fora, então pareceria bastar. NÃO BASTA, e o modo de
// falha é silencioso: a régua da bola consulta primeiro o veredito da IA (`conversation_state`), e
// quando a Janis responde o motor grava AGUARDANDO_CLIENTE. Esse veredito VENCE a conta
// independentemente do `lastOut` que eu passar (src/bola.js:129-142), então o lead sumiria do
// número do mesmo jeito — com um número plausível no lugar do certo.
//
// "De quem é a bola" e "alguém daqui já olhou isto?" são perguntas DIFERENTES. Esta tem conta
// própria, nome próprio, e reaproveita só o que é de fato comum:
//   • as exclusões de lead morto — as mesmas do `awaiting_reply` (src/routes/tenant.js:810);
//   • a regra de que reação não é turno — `naoEhReacaoSql` (src/reacao.js);
//   • a lista de fontes humanas — `FONTES_HUMANAS` (src/staffSamples.js).
// `src/bola.js` segue intocado e segue sendo a única resposta para "devemos resposta".
//
// ─── A DEFINIÇÃO ───────────────────────────────────────────────────────────────────────────────
//
// Um lead está no número enquanto:
//   1. está vivo        — não convertido, sem aula experimental agendada, sem desfecho;
//   2. o cliente falou  — existe mensagem de verdade dele (reação não conta);
//   3. e NENHUMA pessoa da escola respondeu àquele contato — nunca, não "desde a última fala".
//
// ⚠ O item 3 é "primeira resposta", de propósito: é o que o Leo pediu ("à medida que o lead teve a
//   primeira resposta da recepção, ele apaga"). Respondeu uma vez, sai do número para sempre — o
//   que acontece depois é assunto do contador "devemos resposta", que já existe e é outro.
//
// ⚠ CONSEQUÊNCIA ACEITA: quem LÊ o lead e decide não responder (não era lead, é aluno, trote) tem
//   de dar o desfecho no kanban, senão aquele lead fica no número para sempre. A ação já existe; o
//   combinado com a recepção faz parte da entrega, não é detalhe de implementação.
//
// ⚠ EFEITO COLATERAL BOM: lead importado em lote da Extranet não tem mensagem de cliente, então
//   nunca entra aqui. A avalanche de importação não alcança o número do ícone.
//
const { withTenant } = require('./db');
const { naoEhReacaoSql } = require('./reacao');
const { FONTES_HUMANAS } = require('./staffSamples');

// A saída foi uma PESSOA? Duas formas, e as duas contam:
//   • 'web'/'android'/'ios'/'desktop' = a recepcionista digitando no WhatsApp dela (eco do webhook);
//   • 'api' com `sender` diferente do nome da Janis = alguém respondendo pelo painel do Regente.
// $2 é o nome da Janis; $3 é a lista de fontes humanas.
const SAIDA_HUMANA_SQL = `(
  s.source = ANY($3::text[])
  OR (s.source = 'api' AND coalesce(s.sender, '') <> $2)
)`;

// Mesma régua de identidade do resto da casa: br_phone_key (migr 085). Casar "só os dígitos" é o
// que já cruzou grupo com privado neste projeto — não repetir.
const CONTAGEM_SQL = `
  SELECT count(*)::int AS n
    FROM leads l
    -- tenant_id explícito mesmo com RLS: usa o idx_leads_tenant (único índice que a tabela tem
    -- para isto) e deixa a consulta legível fora do contexto. A RLS continua sendo a trava.
   WHERE l.tenant_id = $1
     AND l.status <> 'CONVERTED'
     AND l.status <> 'EXPERIMENTAL_AGENDADA'
     AND l.desfecho IS NULL
     AND br_phone_key(coalesce(l.phone, '')) <> ''
     -- (2) o cliente falou de verdade
     AND EXISTS (
       SELECT 1 FROM messages m
         JOIN conversations cv ON cv.id = m.conversation_id
        WHERE m.role = 'USER'
          AND ${naoEhReacaoSql('m')}
          AND br_phone_key(cv.external_id) = br_phone_key(l.phone)
     )
     -- (3) e NENHUMA pessoa da escola respondeu àquele contato
     AND NOT EXISTS (
       SELECT 1 FROM staff_outbound_samples s
        WHERE br_phone_key(s.external_id) = br_phone_key(l.phone)
          AND ${SAIDA_HUMANA_SQL}
     )`;

/**
 * Quantos leads desta unidade ninguém da casa olhou ainda.
 *
 * Best-effort por fora NÃO: aqui o erro SOBE. Este número vai para o ícone do celular, e um
 * `catch` devolvendo 0 apagaria o aviso da tela da recepção dizendo "está tudo atendido" — a
 * mentira mais cara possível neste recurso. Quem chama decide o que fazer com a falha; o que não
 * se pode é transformar falha em zero.
 */
async function contar(tenantId, deps = {}) {
  const q = deps.withTenant || withTenant;
  return q(tenantId, async (c) => {
    const nomeIa = await _nomeDaIa(c, tenantId);
    const r = await c.query(CONTAGEM_SQL, [tenantId, nomeIa, [...FONTES_HUMANAS]]);
    return r.rows[0].n;
  });
}

// O nome da Janis daquela unidade. O fallback 'Atendimento' é o MESMO de src/autoReply.js:215 —
// se divergir, uma saída da IA passaria por humana (ou o contrário) em um dos dois leitores.
async function _nomeDaIa(c, tenantId) {
  const r = await c.query('SELECT nome_ia FROM automacao_config WHERE tenant_id = $1', [tenantId]);
  const n = r.rows[0] && r.rows[0].nome_ia && String(r.rows[0].nome_ia).trim();
  return n || 'Atendimento';
}

module.exports = { contar, CONTAGEM_SQL, SAIDA_HUMANA_SQL, _nomeDaIa };
