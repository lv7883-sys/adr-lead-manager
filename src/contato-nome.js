'use strict';
// ============================================================================
// RÉGUA ÚNICA: que nome a Caixa de Entrada mostra para um contato.
//
// POR QUE ESTE ARQUIVO EXISTE: a mesma pilha de COALESCE estava escrita TRÊS vezes em
// src/routes/inbox.js — na lista (`projected`), no filtro de busca (`condBusca`) e na conversa
// aberta (`getConversationThread`, em JS). O comentário da busca dizia literalmente "se um mudar, o
// outro tem de mudar", e o terceiro lugar nem era mencionado. É a mesma família de defeito de
// src/reacao.js e src/bola.js: régua copiada divergindo em silêncio — lá a 5ª cópia ignorava o
// veredito da IA; aqui a busca não acharia o nome que a tela mostra.
//
// A ORDEM, e por que cada degrau está onde está:
//   1. AGENDA (contato_agenda, migr 184) — como a UNIDADE salvou. Decisão do Leo em 05/10/2026:
//      "o nome do Regente manda". É o único degrau que alguém escreveu de propósito.
//   2. pushName — o nome que a PRÓPRIA PESSOA pôs no WhatsApp dela. Acima do cadastro DE PROPÓSITO:
//      o cadastro traz o nome do ALUNO e quem fala no WhatsApp é o pai/responsável. Inverter estes
//      dois reintroduz o defeito que a ordem atual corrigiu — não "arrumar" sem ler isto.
//   3. CADASTRO (person.display_name por br_phone_key) — nome canônico de quem está matriculado.
//   4. LEAD (leads.name) — o que o funil capturou.
//   5. NÚMERO — último recurso; nunca mostrar vazio.
//
// O "aluno" é o BADGE discreto ao lado: o nome de cadastro/lead, exibido só quando DIFERE do que
// está sendo mostrado (ex.: contato = responsável, aluno = filho). Mesma função para os dois lugares.
// ============================================================================

// Ordem dos degraus, de maior para menor prioridade. Fonte única da ordem: quem precisar explicar
// a precedência (tela, log, teste) lê daqui em vez de reescrever a lista.
const ORDEM = Object.freeze(['agenda', 'push', 'cadastro', 'lead', 'numero']);

function vazio(v) {
  return v == null || String(v).trim() === '';
}

// ---- lado JS (conversa aberta, testes, qualquer leitura fora de SQL) ----

// Devolve { nome, via } — `via` é o degrau que venceu, para log e para o teste de paridade.
// Nunca devolve nome vazio desde que `numero` venha preenchido.
function nomeContato(f) {
  const v = f || {};
  for (const degrau of ORDEM) {
    if (!vazio(v[degrau])) return { nome: String(v[degrau]).trim(), via: degrau };
  }
  return { nome: '', via: null };
}

// Badge do aluno: cadastro (ou lead, se não houver cadastro) quando difere do nome exibido.
// Comparação por texto cru — "Ana" e "ana " já são o mesmo nome para quem lê a tela.
function alunoBadge(f) {
  const v = f || {};
  const aluno = !vazio(v.cadastro) ? String(v.cadastro).trim()
    : (!vazio(v.lead) ? String(v.lead).trim() : null);
  if (!aluno) return null;
  const { nome } = nomeContato(v);
  return aluno.toLowerCase() === String(nome).toLowerCase() ? null : aluno;
}

// ---- lado SQL (lista e busca do inbox) ----

// Recebe um fragmento SQL por degrau e devolve o COALESCE na ordem canônica. Degrau ausente
// (ex.: a busca não tem o `aluno`) é simplesmente omitido — nunca substituído por NULL literal,
// que mudaria a aritmética de quem conta linhas.
//
// ⚠ Os fragmentos entram CRUS na consulta: só passar nome de coluna/subselect escrito no código,
// nunca entrada de usuário (o inbox passa parâmetros via $n, como já fazia).
function nomeContatoSql(frag) {
  const f = frag || {};
  const degraus = ORDEM.map((d) => f[d]).filter((x) => typeof x === 'string' && x.trim() !== '');
  if (!degraus.length) throw new Error('nomeContatoSql: nenhum degrau informado');
  return degraus.length === 1 ? degraus[0] : `COALESCE(${degraus.join(', ')})`;
}

// BUSCAR não é EXIBIR. Exibir escolhe UM nome (o COALESCE acima); buscar tem de aceitar QUALQUER um
// dos nomes que aquele contato já teve, senão salvar um nome novo ESCONDE a conversa do nome antigo.
//
// Isto não é hipótese: medido em produção em 05/10/2026, logo depois da carga da agenda. A conversa
// cujo pushName era "Deborah Maria Oliveira" foi salva na agenda como "Deborah" — e parou de aparecer
// na busca por "maria", porque a busca casava só o nome EXIBIDO. Dez casos assim em oito termos
// testados. Foi regressão introduzida pelo degrau novo, não defeito antigo.
//
// A concatenação resolve com um alvo só: o LIKE %termo% varre todos os nomes de uma vez. O separador
// é ' | ' (e não espaço) para não colar o fim de um nome no começo do outro e criar casamento que não
// existe em nenhum dos dois.
function todosOsNomesSql(frag) {
  const f = frag || {};
  const partes = ORDEM.filter((d) => d !== 'numero')     // o número tem alvo próprio na busca (dígitos)
    .map((d) => f[d]).filter((x) => typeof x === 'string' && x.trim() !== '');
  if (!partes.length) throw new Error('todosOsNomesSql: nenhum degrau informado');
  return partes.length === 1 ? partes[0] : `concat_ws(' | ', ${partes.join(', ')})`;
}

// Subselect do pushName: a última mensagem do contato que trouxe `sender`. Parametrizado pelo alias
// da conversa porque a lista usa `m.conversation_id` e a busca usa `cv.id`.
function pushNomeSql(colConversationId) {
  return `(SELECT sm.sender FROM messages sm
            WHERE sm.conversation_id = ${colConversationId} AND sm.role = 'USER'
              AND coalesce(sm.sender, '') <> '' ORDER BY sm.received_at DESC LIMIT 1)`;
}

// CTE da agenda + a expressão de junção. A chave é calculada PELO BANCO (br_phone_key quando há
// telefone, external_id cru quando não sobra dígito), igual à migr 184: se a aplicação calculasse,
// seriam duas réguas outra vez.
const AGENDA_CTE = `agenda AS (
      SELECT chave, min(nome) AS nome
        FROM contato_agenda WHERE tenant_id = $1
       GROUP BY chave
    )`;

// `rkey` já é br_phone_key(external_id) nas consultas do inbox; quando é '' (jid sem telefone)
// a chave é o external_id cru.
function chaveAgendaSql(colRkey, colExternalId) {
  return `CASE WHEN coalesce(${colRkey}, '') <> '' THEN ${colRkey} ELSE ${colExternalId} END`;
}

// A MESMA expressão para o INSERT/DELETE, a partir do external_id puro (a rota não tem rkey).
// ⚠ br_phone_key só devolve vazio quando o external_id não tem NENHUM dígito; um jid tipo '…@lid'
// vira os dígitos dele, não o jid cru (medido 05/10/2026). A chave continua estável por contato.
function chaveAgendaDeExternalIdSql(param) {
  return `coalesce(nullif(br_phone_key(${param}), ''), ${param})`;
}

module.exports = {
  ORDEM,
  nomeContato,
  alunoBadge,
  nomeContatoSql,
  todosOsNomesSql,
  pushNomeSql,
  AGENDA_CTE,
  chaveAgendaSql,
  chaveAgendaDeExternalIdSql,
};
