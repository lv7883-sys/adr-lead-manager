'use strict';
//
// check-sql.js — avalia uma restrição CHECK do PostgreSQL em JavaScript, contra uma linha.
//
// POR QUE ISTO EXISTE
//
// A camada 1 da conferência do seed precisa responder, SEM BANCO, se cada linha que o plano vai
// gravar satisfaz as restrições CHECK que a tabela REALMENTE tem. "Realmente" é a palavra toda: o
// texto das restrições é lido de `pg_constraint` em produção e congelado num arquivo (ver
// `deploy/dump-esquema-demo.js`), porque ler a migração que criou a tabela MENTE — a 092 define
//
//     CHECK (marco IN ('D-10','D-2'))
//
// e a 109 troca a mesma restrição por
//
//     CHECK (marco IN ('D-45','D-30','D-15','D-10','D-7','D-2'))
//
// Quem conferir pelo arquivo de origem acha que 'D-45' é inválido. Quem conferir pelo banco acerta.
//
// ─── A REGRA QUE MAIS IMPORTA: TRÊS VALORES, NÃO DOIS ────────────────────────────────────────
//
// No PostgreSQL um CHECK só REPROVA quando a expressão dá FALSE. Se der NULL (desconhecido), a
// linha PASSA. Então `CHECK (status IN ('a','b'))` aceita `status = NULL` sem reclamar. Avaliar
// isso com a lógica de dois valores do JavaScript produziria reprovação falsa — e reprovação
// falsa é pior que nenhuma conferência, porque treina quem lê a ignorar.
//
// ─── E O MODO DE FALHA: RECUSAR, NUNCA CHUTAR ────────────────────────────────────────────────
//
// O avaliador entende um SUBCONJUNTO de SQL (comparações, IS NULL, listas, AND/OR, e um punhado
// de funções de uma entrada). Qualquer expressão fora desse subconjunto faz ele LANÇAR, com o
// texto original na mensagem. Nunca devolve "passou" por não ter entendido — era exatamente esse
// o defeito da trava que não pegou o incidente que a criou: proteção que mede o que conhece e
// cala sobre o que não conhece.
//

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1) Tokenizador
// ─────────────────────────────────────────────────────────────────────────────────────────────
const SIMBOLOS = ['<>', '!=', '>=', '<=', '::', '(', ')', ',', '=', '<', '>'];

function tokeniza(src) {
  const t = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === "'") {                       // literal de texto, com '' como escape
      let j = i + 1; let s = '';
      for (;;) {
        if (j >= src.length) throw new Error(`check-sql: literal de texto não fechado em ${JSON.stringify(src)}`);
        if (src[j] === "'") {
          if (src[j + 1] === "'") { s += "'"; j += 2; continue; }
          j += 1; break;
        }
        s += src[j]; j += 1;
      }
      t.push({ k: 'texto', v: s }); i = j; continue;
    }
    const sim = SIMBOLOS.find((x) => src.startsWith(x, i));
    if (sim) { t.push({ k: sim }); i += sim.length; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
      t.push({ k: 'numero', v: Number(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-z_"]/.test(c)) {
      const m = /^("[^"]+"|[A-Za-z_][A-Za-z_0-9$]*)/.exec(src.slice(i));
      if (!m) throw new Error(`check-sql: identificador inesperado em ${JSON.stringify(src.slice(i, i + 20))}`);
      const cru = m[0];
      t.push({ k: 'ident', v: cru.startsWith('"') ? cru.slice(1, -1) : cru.toLowerCase() });
      i += cru.length; continue;
    }
    throw new Error(`check-sql: caractere não suportado ${JSON.stringify(c)} em ${JSON.stringify(src)}`);
  }
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2) Funções de UMA entrada que o avaliador conhece. Fora desta lista, ele recusa.
//    Cada uma recebe o valor já resolvido (ou null) e devolve valor (ou null = desconhecido).
// ─────────────────────────────────────────────────────────────────────────────────────────────
const FUNCOES = Object.freeze({
  btrim: (v) => (v == null ? null : String(v).replace(/^\s+|\s+$/g, '')),
  trim: (v) => (v == null ? null : String(v).replace(/^\s+|\s+$/g, '')),
  lower: (v) => (v == null ? null : String(v).toLowerCase()),
  upper: (v) => (v == null ? null : String(v).toUpperCase()),
  length: (v) => (v == null ? null : String(v).length),
  char_length: (v) => (v == null ? null : String(v).length),
  abs: (v) => (v == null ? null : Math.abs(Number(v))),
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3) Analisador descendente recursivo + avaliação em lógica de TRÊS valores.
//    `null` representa UNKNOWN. true/false representam TRUE/FALSE.
// ─────────────────────────────────────────────────────────────────────────────────────────────
function _e3(a, b) {   // AND de três valores
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return true;
}
function _ou3(a, b) {  // OR de três valores
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return false;
}

/**
 * Avalia o texto de um CHECK contra uma linha.
 *
 * @param {string} texto  o que `pg_get_constraintdef` devolveu, com ou sem o prefixo "CHECK (…)"
 * @param {Record<string, any>} linha  coluna → valor (undefined = coluna ausente do plano)
 * @param {{colunasConhecidas?: Set<string>}} [opts]
 * @returns {true|false|null}  TRUE / FALSE / UNKNOWN — e no Postgres só FALSE reprova
 */
function avaliaCheck(texto, linha, opts = {}) {
  let src = String(texto).trim();
  const semPrefixo = /^CHECK\s*\((.*)\)$/is.exec(src);
  if (semPrefixo) src = semPrefixo[1];
  const t = tokeniza(src);
  let i = 0;

  const olha = (n = 0) => t[i + n];
  const ehIdent = (p, v) => p && p.k === 'ident' && p.v === v;
  const come = (k) => { if (!olha() || olha().k !== k) erro(`esperava ${k}`); i += 1; };
  const erro = (msg) => {
    throw new Error(
      `check-sql: ${msg} — restrição não compreendida, e o avaliador RECUSA em vez de chutar. `
      + `Texto: ${JSON.stringify(texto)}`);
  };

  // valor literal ou referência de coluna (com função de uma entrada), já com cast descartado
  function valor() {
    const p = olha();
    if (!p) erro('fim inesperado');
    let v;
    if (p.k === 'texto' || p.k === 'numero') { v = { tipo: 'lit', v: p.v }; i += 1; }
    else if (p.k === 'ident' && (p.v === 'true' || p.v === 'false')) { v = { tipo: 'lit', v: p.v === 'true' }; i += 1; }
    else if (p.k === 'ident' && p.v === 'null') { v = { tipo: 'lit', v: null }; i += 1; }
    else if (p.k === 'ident') {
      const nome = p.v; i += 1;
      if (olha() && olha().k === '(') {           // função
        if (!FUNCOES[nome]) erro(`função ${nome}() não está na lista de funções conhecidas`);
        come('(');
        const dentro = valor();
        if (olha() && olha().k === ',') erro(`função ${nome}() com mais de um argumento`);
        come(')');
        v = { tipo: 'fn', fn: nome, arg: dentro };
      } else {
        if (opts.colunasConhecidas && !opts.colunasConhecidas.has(nome)) {
          erro(`coluna ${JSON.stringify(nome)} não existe na tabela conforme o esquema congelado`);
        }
        v = { tipo: 'col', nome };
      }
    } else if (p.k === '(') {                      // parênteses em posição de valor
      come('(');
      v = valor();
      come(')');
    } else erro(`token inesperado ${p.k}`);
    while (olha() && olha().k === '::') { come('::'); if (!olha() || olha().k !== 'ident') erro('cast sem tipo'); i += 1; while (olha() && olha().k === '(') { come('('); while (olha() && olha().k !== ')') i += 1; come(')'); } }
    return v;
  }

  function resolve(no) {
    if (no.tipo === 'lit') return no.v;
    if (no.tipo === 'col') {
      const x = linha[no.nome];
      return x === undefined ? null : x;   // coluna ausente do plano = o banco põe o default
    }
    return FUNCOES[no.fn](resolve(no.arg));
  }

  function listaDeLiterais() {
    // Lista entre parênteses: `(a, b, c)`. O `ARRAY` de `= ANY (ARRAY[...])` já foi consumido por
    // quem chama, e `normalizaDefinicao` trocou os colchetes por parênteses.
    const fora = [];
    come('(');
    for (;;) {
      fora.push(resolve(valor()));
      if (olha() && olha().k === ',') { come(','); continue; }
      break;
    }
    come(')');
    return fora;
  }

  function comparaIgualdade(a, b) {
    if (a === null || b === null) return null;
    if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
    return String(a) === String(b);
  }

  function atomo() {
    const esq = valor();
    const p = olha();

    // Coluna booleana usada como predicado: `CHECK (is_group OR ...)`, `CHECK (NOT (a AND b))`.
    // Nada foi consumido além do valor, então quem chamou segue de onde parou (AND/OR/fecha).
    const OPS = new Set(['=', '<>', '!=', '>', '<', '>=', '<=']);
    const continua = p && (OPS.has(p.k) || ehIdent(p, 'is') || ehIdent(p, 'in')
      || (ehIdent(p, 'not') && ehIdent(olha(1), 'in')));
    if (!continua) {
      const v = resolve(esq);
      if (v === null) return null;
      if (typeof v === 'boolean') return v;
      return erro(
        `valor ${JSON.stringify(v)} usado como condição sem operador (e não é booleano)`);
    }

    if (ehIdent(p, 'is')) {
      i += 1;
      let negado = false;
      if (ehIdent(olha(), 'not')) { negado = true; i += 1; }
      if (ehIdent(olha(), 'null')) {
        i += 1;
        const nulo = resolve(esq) === null;
        return negado ? !nulo : nulo;
      }
      if (ehIdent(olha(), 'true') || ehIdent(olha(), 'false')) {
        const alvo = olha().v === 'true'; i += 1;
        const v = resolve(esq);
        const igual = v === null ? false : Boolean(v) === alvo;
        return negado ? !igual : igual;
      }
      erro('IS seguido de algo que não é NULL/TRUE/FALSE');
    }

    if (ehIdent(p, 'in')) {
      i += 1;
      const lista = listaDeLiterais();
      const v = resolve(esq);
      if (v === null) return null;
      if (lista.some((x) => comparaIgualdade(v, x) === true)) return true;
      return lista.some((x) => x === null) ? null : false;
    }

    if (ehIdent(p, 'not') && ehIdent(olha(1), 'in')) {
      i += 2;
      const lista = listaDeLiterais();
      const v = resolve(esq);
      if (v === null) return null;
      if (lista.some((x) => comparaIgualdade(v, x) === true)) return false;
      return lista.some((x) => x === null) ? null : true;
    }

    if (p.k === '=' || p.k === '<>' || p.k === '!=' || p.k === '>' || p.k === '<' || p.k === '>=' || p.k === '<=') {
      const op = p.k; i += 1;
      // `= ANY (ARRAY[...])` é como o pg_get_constraintdef escreve um IN
      if (ehIdent(olha(), 'any') || ehIdent(olha(), 'all')) {
        const quantificador = olha().v; i += 1;
        come('(');
        if (!ehIdent(olha(), 'array')) erro(`${quantificador.toUpperCase()} sem ARRAY`);
        i += 1;
        // ARRAY[ … ] — o '[' não é símbolo do tokenizador, então ele virá como caractere inválido:
        // o dump é normalizado antes (ver normalizaDefinicao) e os colchetes já viraram parênteses.
        const lista = listaDeLiterais();
        come(')');
        const v = resolve(esq);
        if (v === null) return null;
        const bate = (x) => (op === '=' ? comparaIgualdade(v, x) : comparaIgualdade(v, x) === null ? null : !comparaIgualdade(v, x));
        if (quantificador === 'any') {
          if (lista.some((x) => bate(x) === true)) return true;
          return lista.some((x) => bate(x) === null) ? null : false;
        }
        if (lista.some((x) => bate(x) === false)) return false;
        return lista.some((x) => bate(x) === null) ? null : true;
      }
      const dir = valor();
      const a = resolve(esq); const b = resolve(dir);
      if (a === null || b === null) return null;
      switch (op) {
        case '=': return comparaIgualdade(a, b);
        case '<>': case '!=': return !comparaIgualdade(a, b);
        default: {
          const na = typeof a === 'number' ? a : String(a);
          const nb = typeof b === 'number' ? b : String(b);
          if (op === '>') return na > nb;
          if (op === '<') return na < nb;
          if (op === '>=') return na >= nb;
          return na <= nb;
        }
      }
    }
    return erro(`operador não suportado (${p.k}${p.v ? ' ' + p.v : ''})`);
  }

  function primario() {
    if (olha() && olha().k === '(') {
      // Pode ser agrupamento booleano OU um valor entre parênteses. Tenta booleano e, se a
      // leitura não consumir o fecha-parênteses, volta e trata como comparação.
      const salvo = i;
      come('(');
      try {
        const v = ou();
        if (olha() && olha().k === ')') { come(')'); return v; }
      } catch { /* não era expressão booleana — cai no atomo abaixo */ }
      i = salvo;
      return atomo();
    }
    if (ehIdent(olha(), 'not')) { i += 1; const v = primario(); return v === null ? null : !v; }
    return atomo();
  }

  function e() {
    let v = primario();
    while (ehIdent(olha(), 'and')) { i += 1; v = _e3(v, primario()); }
    return v;
  }
  function ou() {
    let v = e();
    while (ehIdent(olha(), 'or')) { i += 1; v = _ou3(v, e()); }
    return v;
  }

  const r = ou();
  if (i !== t.length) erro(`sobrou texto não analisado a partir do token ${i}`);
  return r;
}

/**
 * Normaliza o que `pg_get_constraintdef` devolve para o que o tokenizador aceita.
 *
 * Só duas trocas, ambas sintáticas: `ARRAY[...]` → `ARRAY(...)` (o tokenizador não tem colchete)
 * e colapso de espaços. Nenhum literal é tocado — a troca de colchete é feita apenas FORA de
 * literais de texto, senão um nome com '[' dentro viraria outro valor.
 */
function normalizaDefinicao(def) {
  const s = String(def);
  let fora = '';
  let emTexto = false;
  for (let k = 0; k < s.length; k += 1) {
    const c = s[k];
    if (c === "'") { emTexto = !emTexto; fora += c; continue; }
    if (!emTexto && c === '[') { fora += '('; continue; }
    if (!emTexto && c === ']') { fora += ')'; continue; }
    fora += c;
  }
  return fora.replace(/\s+/g, ' ').trim();
}

module.exports = { avaliaCheck, normalizaDefinicao, tokeniza, FUNCOES };
