'use strict';
//
//
// ⚠⚠ NADA DE CRASE NOS COMENTÁRIOS DAQUI PARA BAIXO. As consultas deste arquivo são template
//    literals, e uma crase solta num comentário ENCERRA a string: o módulo deixa de carregar com
//    um erro que aponta para a palavra seguinte, não para a crase. Eu quebrei este arquivo assim
//    em 18/11/2026, e o recep-layout.js do dashboard no mesmo dia — quatro vezes em dois dias.
//    O routes/tenant.js já avisava isso por extenso; o aviso não estava AQUI, onde eu estava
//    escrevendo. Use aspas, ou nada. O `node --check` pega, mas só depois de perder a rodada.
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
const logger = require('./logger');
const { naoEhReacaoSql } = require('./reacao');
const { FONTES_HUMANAS } = require('./staffSamples');

// O QUE TIRA UM LEAD DO NÚMERO DO ÍCONE — e isto é CONFIGURÁVEL por unidade desde 18/11/2026,
// pedido do Leo: "para o caso de um dia termos a agente de IA respondendo os leads interinamente".
//
//   'humano'       (padrão, decisão do Leo em 18/11/2026) — só PESSOA tira o lead do ícone.
//                  A resposta automática da Janis não conta: o número mede trabalho da equipe.
//   'humano_ou_ia' — a resposta da IA também conta. O número passa a significar "ninguém
//                  ATENDEU ainda" em vez de "nenhuma PESSOA olhou ainda". É o modo para quando a
//                  assistente assumir o primeiro atendimento.
//
// ⚠ A VERSÃO ANTERIOR DECIDIA AUTORIA PELO NOME, e isso falhou — medido em produção em
//   18/11/2026 pela revisão independente. A regra era "`sender` diferente do `nome_ia` atual", e
//   com isso: SERVICE (3.581 linhas, que é o PAPEL DO TOKEN e não autoria) contava como pessoa, e
//   os nomes ANTIGOS da Janis — 'Janis J.' (26), 'Janis Joplin' (6), 'Janis' (5) — também. Ou
//   seja: **trocar o nome da assistente reescrevia o passado**, e 37 respostas dela passavam a
//   valer como atendimento humano. Nenhum erro aparecia; o número ficava plausível e errado.
//
//   O conserto é estrutural: `autor_tipo` (migr 193) grava QUEM escreveu no momento da escrita.
//   Nome é rótulo editável; autoria é fato.
//
// $4 = modo ('humano' | 'humano_ou_ia'); $3 = lista de fontes humanas.
const SAIDA_CONTA_SQL = `(
  -- Modo 'humano_ou_ia': qualquer saída nossa conta, inclusive a da IA.
  $4 = 'humano_ou_ia'
  -- Fonte é prova DIRETA de pessoa: o eco do webhook traz o aparelho de onde foi digitado.
  OR s.source = ANY($3::text[])
  -- Autoria declarada na escrita (migr 193). É o caminho que vale daqui para frente.
  OR s.autor_tipo = 'humano'
  -- ⚠ FALLBACK PARA O PASSADO, e ele assume um risco POR ESCRITO. Linha antiga sem autoria
  --   declarada: conta como pessoa se NÃO for automação conhecida. Isso inclui 'SERVICE' (o painel
  --   do Regente) e as 49.276 linhas de 'historico' (a importação do WhatsApp).
  --   O risco: 'SERVICE' é o papel do token, não autoria — se um dia uma automação nova enviar
  --   sem declarar autor_tipo, ela cai aqui e conta como gente. A alternativa era pior: não
  --   contar 'SERVICE' marcaria como "ninguém olhou" 13 leads que a recepção DE FATO respondeu
  --   pelo painel (medido em 18/11/2026). Dado histórico não tem conserto; o que tem conserto é
  --   o futuro, e é a coluna. Quando não sobrar linha com autor_tipo NULL, esta cláusula morre.
  OR (s.autor_tipo IS NULL
      AND coalesce(s.sender, '') NOT IN ('boas-vindas-auto', 'renovacao-auto')
      AND coalesce(s.sender, '') <> $2)
)`;
// Mantido o nome antigo como apelido: havia leitor externo citando-o.
const SAIDA_HUMANA_SQL = SAIDA_CONTA_SQL;

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
          -- ⚠ cv.tenant_id e cv.channel NÃO são decoração: o índice que serve esta junção
          --   (idx_conversations_brphonekey) é (tenant_id, br_phone_key(external_id)) **PARCIAL**,
          --   com WHERE channel='whatsapp'. Sem estas duas linhas o planejador não pode usá-lo e
          --   cai em varredura — foi parte dos 2,8-6,6 s medidos em 18/11/2026. E é consistente
          --   com o resto da consulta, que já exige br_phone_key(l.phone) <> '' (lead COM
          --   telefone = WhatsApp; DM da Meta é identificada por psid e não entra aqui).
          AND cv.tenant_id = $1
          AND cv.channel = 'whatsapp'
          AND br_phone_key(cv.external_id) = br_phone_key(l.phone)
     )
     -- (3) e NENHUMA pessoa da escola respondeu àquele contato
     AND NOT EXISTS (
       SELECT 1 FROM staff_outbound_samples s
        -- ⚠ s.br_key, NÃO br_phone_key(s.external_id) — e a diferença foi medida: calcular a
        --   chave nas 86 mil linhas custava 1.909 ms por consulta, contra 107 ms para LER a
        --   tabela. O custo era função, não I/O (br_phone_key é SQL mas tem CTE no corpo, então o
        --   Postgres não a inlina). A coluna é mantida por gatilho (migr 194) e tem índice
        --   (tenant_id, br_key) — é o mesmo padrão que conversations.br_key já usava ao lado.
        WHERE s.tenant_id = $1
          AND s.br_key = br_phone_key(l.phone)
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
    const cfg = await _configDaUnidade(c, tenantId);
    const r = await c.query(CONTAGEM_SQL, [tenantId, cfg.nomeIa, [...FONTES_HUMANAS], cfg.modo]);
    return r.rows[0].n;
  });
}

const MODOS = ['humano', 'humano_ou_ia'];

/**
 * O nome da Janis e o modo de contagem da unidade, numa consulta só — a mesma linha, porque este
 * caminho roda no instante em que a mensagem do cliente chega.
 *
 * ⚠ Modo desconhecido (coluna ainda não aplicada, valor estranho) cai em 'humano', que é a decisão
 *   do Leo e o comportamento mais conservador: deixar o lead NO ícone erra para o lado de pedir
 *   atenção, não para o lado de dizer "já atendido". Se um dia alguém inverter este default, o
 *   efeito é silencioso — leads desaparecem do ícone sem ninguém ter olhado.
 */
async function _configDaUnidade(c, tenantId) {
  // A coluna pode não existir ainda (migr 193 não aplicada): neste caso não dá para pedi-la, ou a
  // consulta inteira falha e o ícone some. A régua do projeto é "fail-closed com aviso", e aqui o
  // fechado é 'humano'.
  let modo = 'humano';
  let nomeIa = null;
  try {
    const r = await c.query('SELECT nome_ia, conta_como_atendido FROM automacao_config WHERE tenant_id = $1', [tenantId]);
    nomeIa = r.rows[0] && r.rows[0].nome_ia;
    const m = r.rows[0] && r.rows[0].conta_como_atendido;
    if (MODOS.includes(m)) modo = m;
  } catch (e) {
    if (e && e.code === '42703') {   // coluna inexistente
      const r2 = await c.query('SELECT nome_ia FROM automacao_config WHERE tenant_id = $1', [tenantId]);
      nomeIa = r2.rows[0] && r2.rows[0].nome_ia;
      logger.warn('sem_atendimento.sem_coluna_modo', { tenant_id: tenantId, assumido: 'humano' });
    } else throw e;
  }
  const n = nomeIa && String(nomeIa).trim();
  return { modo, nomeIa: n || 'Atendimento' };
}

// O nome da Janis daquela unidade. O fallback 'Atendimento' é o MESMO de src/autoReply.js:215 —
// se divergir, uma saída da IA passaria por humana (ou o contrário) em um dos dois leitores.
async function _nomeDaIa(c, tenantId) {
  const r = await c.query('SELECT nome_ia FROM automacao_config WHERE tenant_id = $1', [tenantId]);
  const n = r.rows[0] && r.rows[0].nome_ia && String(r.rows[0].nome_ia).trim();
  return n || 'Atendimento';
}

module.exports = { contar, CONTAGEM_SQL, SAIDA_HUMANA_SQL, SAIDA_CONTA_SQL, MODOS, _nomeDaIa, _configDaUnidade };
