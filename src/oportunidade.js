'use strict';
//
// oportunidade.js — RÉGUA ÚNICA: "esta conversa fala de uma oportunidade NOVA?"
//
// Existe porque a pergunta já tinha resposta no sistema e nenhum leitor. O classificador de
// CONVERSA (gemini.classifyConversa) devolve `intent` ∈ NOVA_OPORTUNIDADE | ROTINA_CLIENTE |
// INTERNO | CANDIDATO | INDEFINIDO e o engine grava esse veredito em `leads.classification_signals`
// (engine.js, Portão 2). Até 20/11/2026 esse campo era lido em DOIS lugares: para pescar
// 'CANDIDATO' (descartados.js) e para devolver no payload da fila de Revisar. Nenhuma fila,
// nenhum contador e nenhuma tela perguntavam "tem oportunidade aqui?".
//
// O CUSTO DISSO, MEDIDO EM PRODUÇÃO (Valinhos, 20/11/2026):
//   54 leads são alunos e carregam ficha viva no funil
//   20 deles têm NOVA_OPORTUNIDADE gravado  <- a IA viu negócio novo e ninguém leu
//   só 3 aparecem na lista de 2º curso; 12 não aparecem em fila de venda nenhuma
//   leads novos de verdade no mesmo mês: 4
// Ou seja: a oportunidade vinda de quem JÁ É CLIENTE é mais frequente que lead novo, e era
// invisível. Exemplos do próprio texto da IA: "a cliente existente (mãe da Isa) está indicando
// sua sobrinha", "pergunta se pode levar um amigo do Benício", "agendando aula experimental
// para o Matheus em um novo curso de bateria".
//
// POR QUE UM ARQUIVO SÓ PARA ISTO: mesma razão de src/bola.js (eram CINCO cópias da régua) e de
// src/contato-nome.js (eram QUATRO). Esta régua nasceu precisando de três leitores no mesmo dia
// — o filtro da aba, a etiqueta da conversa e a fila de oportunidade. Régua copiada é régua que
// diverge, e neste projeto isso já custou semanas.
//
// A REGRA DO DONO (20/11/2026), que este arquivo serve: "só quero que o lead seja reconhecido e
// tratado como lead independentemente de o contato ser conhecido ou não (seja ele aluno, pais ou
// responsáveis, professores, etc.)". Ela não é nova: o ADR-036 (aprovado em 07/07/2026) já
// decidia "Aluno novo = lead novo, sempre, mesmo que a conta/contrato já exista".
//
// O QUE ESTE ARQUIVO NÃO FAZ, de propósito: não muda status, não move ninguém de etapa, não
// cria ficha. A trava "FATO VENCE CLASSIFICAÇÃO" (engine.js:949) existe por um incidente medido
// em 17-18/09/2026 — 4 de 36 leads voltaram a NOT_LEAD no segundo em que mandaram mensagem — e
// continua intocada. Aqui só se LÊ um sinal que já está gravado.
//

// Os vereditos do classificador de conversa que significam "tem negócio novo aqui".
//
// RELACIONAMENTO_OPORTUNIDADE entra junto porque é o MESMO fato visto por outra porta: o engine
// grava esse valor quando o contato é de relacionamento (hoje: professor) e a conversa tem sinal
// de oportunidade — ou seja, oportunidade que foi mandada para confirmação humana. Deixar de
// fora faria a oportunidade de um professor valer menos que a de um aluno, e a regra do dono
// diz explicitamente "seja ele aluno, pais ou responsáveis, professores, etc.".
const SINAIS_OPORTUNIDADE = Object.freeze(['NOVA_OPORTUNIDADE', 'RELACIONAMENTO_OPORTUNIDADE']);

// `classification_signals` é jsonb e tem TRÊS formas no banco de produção, por idade:
//   1. array de vereditos            ["NOVA_OPORTUNIDADE"]            (formato vivo)
//   2. array de sinais livres        ["interesse em produção musical", "curso Home Studio"]
//   3. objeto de um lote antigo      {"tier": "...", "intent": "ROTINA_CLIENTE", ...}
// Por isso a comparação é feita sobre o TEXTO do jsonb: ela atravessa as três formas sem precisar
// de um `CASE` por formato, e um objeto cujo `intent` seja NOVA_OPORTUNIDADE casa — o que está
// certo, porque é a mesma informação escrita de outro jeito.
function temOportunidade(lead) {
  if (!lead) return false;
  const s = lead.classification_signals;
  if (s == null) return false;
  const texto = typeof s === 'string' ? s : JSON.stringify(s);
  return SINAIS_OPORTUNIDADE.some((k) => texto.includes(k));
}

// Gêmeo SQL de temOportunidade. Usa o mesmo `::text LIKE` pelo mesmo motivo acima.
// Devolve false (não NULL) quando a coluna é NULL: `coalesce` antes do LIKE — sem isso, negar
// esta expressão com NOT devolveria NULL e a linha sumiria sem erro. Essa armadilha custou 366
// conversas numa medição de 20/11 e está documentada em routes/inbox.js.
function oportunidadeSql(alias = 'l') {
  const col = `coalesce(${alias}.classification_signals::text, '')`;
  return '(' + SINAIS_OPORTUNIDADE.map((k) => `${col} LIKE '%${k}%'`).join(' OR ') + ')';
}

module.exports = { SINAIS_OPORTUNIDADE, temOportunidade, oportunidadeSql };
