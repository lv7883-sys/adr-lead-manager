'use strict';
//
// credenciais.js — CREDENCIAL É DA UNIDADE, NÃO DO PROCESSO.
//
// Com a chave num arquivo de ambiente, todas as unidades do container usam a MESMA chave de
// IA, o MESMO token de Meta, a MESMA instância de Evolution. Num produto vendido por unidade
// isso é três problemas de uma vez: custo que não se atribui a ninguém, bloqueio de um
// provedor que derruba todo mundo junto, e o cliente que não consegue usar a conta dele.
//
// CIFRA DA APLICAÇÃO, NÃO DO BANCO (src/crypto.js, AES-256-GCM, LM_ENCRYPTION_KEY):
// com pgcrypto a chave viajaria como parâmetro de cada consulta e acabaria em log de erro,
// em pg_stat_statements e no dump — o backup deixaria de proteger o segredo, porque chave e
// segredo passariam a morar no mesmo lugar. Assim, quem tem o dump não tem as credenciais.
//
// REGRA DO MÓDULO: nenhum código do motor de marketing lê credencial de process.env.
// Não existe fallback para ambiente de propósito — um fallback silencioso faria a unidade
// errada gastar na conta errada, que é justamente o que este arquivo existe para impedir.
//
const { withTenant } = require('../db');
const { encrypt, decrypt } = require('../crypto');
const logger = require('../logger');

// Cache curto: a credencial muda quando o cliente troca a chave dele, e aí no máximo
// TTL segundos depois o trabalhador já está usando a nova. Curto o bastante para não segurar
// credencial revogada, longo o bastante para não consultar o banco a cada chamada de IA.
const TTL_MS = Number(process.env.PLATAFORMA_CREDENCIAL_TTL_MS || 60_000);
const MAX_ENTRADAS = 500;

const _cache = new Map();   // chave -> { valor, expiraEm }

// A chave do cache SEMPRE começa pela unidade. É o que impede a credencial de A de ser
// servida num trabalho de B (o teste de isolamento prova isso).
const _chave = (tenantId, provedor, tipo) => `${tenantId}|${provedor}|${tipo}`;

// Falha ALTA e cedo se a chave de cifra não estiver no ambiente. `src/crypto.js` tem um
// fallback de desenvolvimento ('insecure-dev-key') que serve para token de teste, NÃO para
// guardar credencial de cliente: silenciar isto gravaria segredo com chave pública conhecida.
function _exigeChaveDeCifra() {
  if (!process.env.LM_ENCRYPTION_KEY) {
    const err = new Error('LM_ENCRYPTION_KEY ausente: não é possível ler/gravar credencial de unidade');
    err.code = 'CHAVE_DE_CIFRA_AUSENTE';
    throw err;
  }
}

/**
 * Credencial de UMA unidade. Retorna a string em claro ou null (não existe, vencida ou
 * revogada). O valor nunca vai para log — nem aqui, nem em quem chama.
 */
async function lerCredencial(tenantId, provedor, tipo, { agora = Date.now() } = {}) {
  if (!tenantId || !provedor || !tipo) return null;
  const ck = _chave(tenantId, provedor, tipo);
  const hit = _cache.get(ck);
  if (hit && hit.expiraEm > agora) return hit.valor;

  _exigeChaveDeCifra();
  const cifrado = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT valor_cifrado
         FROM plataforma.credencial_unidade
        WHERE tenant_id = $1 AND provedor = $2 AND tipo = $3
          AND revogado_em IS NULL
          AND (expira_em IS NULL OR expira_em > now())`,
      [tenantId, provedor, tipo]);
    return r.rows[0] ? r.rows[0].valor_cifrado : null;
  });

  // decrypt() devolve '' quando a cifra não abre (chave trocada, linha corrompida).
  // Tratar como ausente é o certo: melhor "sem credencial" do que passar lixo ao provedor.
  const valor = cifrado ? (decrypt(cifrado) || null) : null;
  if (cifrado && valor === null) {
    logger.error('credencial.nao_decifra', { tenant_id: tenantId, provedor, tipo });
  }

  if (_cache.size >= MAX_ENTRADAS) _cache.clear();   // poda burra e barata
  _cache.set(ck, { valor, expiraEm: agora + TTL_MS });
  return valor;
}

/**
 * Grava/atualiza a credencial de uma unidade. Usado pela tela de configuração, pelo
 * onboarding e pelos testes. `metadados` guarda o que NÃO é segredo (e-mail, perfil, id da
 * unidade na Extranet, validade) e sobrevive à exclusão do segredo.
 * O valor em claro não persiste em lugar nenhum.
 */
async function gravarCredencial(tenantId, provedor, tipo, valor, { expiraEm = null, metadados = {} } = {}) {
  if (!tenantId || !provedor || !tipo) throw new Error('unidade/provedor/tipo obrigatórios');
  _exigeChaveDeCifra();
  const cifrado = encrypt(String(valor));
  if (!cifrado) throw new Error('valor vazio: nada a cifrar');
  await withTenant(tenantId, (c) => c.query(
    `INSERT INTO plataforma.credencial_unidade
       (tenant_id, provedor, tipo, valor_cifrado, expira_em, metadados)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (tenant_id, provedor, tipo) DO UPDATE
       SET valor_cifrado = EXCLUDED.valor_cifrado,
           expira_em     = EXCLUDED.expira_em,
           metadados     = EXCLUDED.metadados,
           revogado_em   = NULL,
           atualizado_em = now()`,
    [tenantId, provedor, tipo, cifrado, expiraEm, JSON.stringify(metadados || {})]));
  invalidar(tenantId, provedor, tipo);
  // O log registra QUE gravou, nunca O QUE gravou.
  logger.info('credencial.gravada', { tenant_id: tenantId, provedor, tipo });
}

// Revogação NA ORIGEM: trocar a senha na Extranet, revogar o token OAuth, girar a chave.
// 'nao_aplicavel' = não existe o que revogar do outro lado (ex.: uma configuração que não
// é segredo de terceiro).
const REVOGACAO_ORIGEM = new Set(['sim', 'nao', 'nao_aplicavel']);

/**
 * Revoga: APAGA o segredo daqui e mantém a linha, com a trilha (quem, qual provedor, quando).
 *
 * ⚠ APAGAR AQUI NÃO ENCERRA A EXPOSIÇÃO. Os backups já gravados continuam com aquele
 * segredo cifrado, e a chave de decifragem é a mesma — quem tiver os dois, abre. O que
 * encerra de verdade é revogar NA ORIGEM: trocar a senha da Extranet, revogar o token
 * OAuth, girar o token da Evolution. Aí o que está no backup vira inútil.
 *
 * Por isso `naOrigem` é registrado em metadados: a lista das credenciais apagadas daqui e
 * AINDA VIVAS do outro lado é o que importa num incidente — `pendentesNaOrigem()` devolve
 * exatamente essa lista.
 *
 * @param {'sim'|'nao'|'nao_aplicavel'} naOrigem  o que foi feito na origem (padrão 'nao')
 */
async function revogarCredencial(tenantId, provedor, tipo, { naOrigem = 'nao' } = {}) {
  const origem = REVOGACAO_ORIGEM.has(naOrigem) ? naOrigem : 'nao';
  const n = await withTenant(tenantId, async (c) => (await c.query(
    `UPDATE plataforma.credencial_unidade
        SET valor_cifrado = NULL,
            revogado_em = now(),
            metadados = metadados || jsonb_build_object(
              'revogado_na_origem', $4::text,
              'revogado_na_origem_em', CASE WHEN $4 = 'sim' THEN to_jsonb(now()) ELSE 'null'::jsonb END),
            atualizado_em = now()
      WHERE tenant_id = $1 AND provedor = $2 AND tipo = $3 AND revogado_em IS NULL`,
    [tenantId, provedor, tipo, origem])).rowCount);
  invalidar(tenantId, provedor, tipo);
  if (n) {
    logger.info('credencial.revogada', { tenant_id: tenantId, provedor, tipo, na_origem: origem });
    if (origem === 'nao') {
      // Alto de propósito: a credencial sumiu daqui e continua valendo no provedor.
      logger.warn('credencial.viva_na_origem', { tenant_id: tenantId, provedor, tipo });
    }
  }
  return n;
}

/**
 * Credenciais apagadas daqui que **ainda podem estar vivas no provedor** — a lista que
 * importa num incidente, porque o segredo delas continua nos backups antigos.
 */
async function pendentesNaOrigem(tenantId) {
  return withTenant(tenantId, async (c) => (await c.query(
    `SELECT provedor, tipo, revogado_em, metadados
       FROM plataforma.credencial_unidade
      WHERE tenant_id = $1
        AND revogado_em IS NOT NULL
        AND coalesce(metadados->>'revogado_na_origem', 'nao') = 'nao'
      ORDER BY revogado_em DESC`,
    [tenantId])).rows);
}

/** O que NÃO é segredo (para telas de configuração e diagnóstico). Nunca devolve o valor. */
async function metadadosCredencial(tenantId, provedor, tipo) {
  return withTenant(tenantId, async (c) => (await c.query(
    `SELECT provedor, tipo, metadados, expira_em, verificado_em, revogado_em, atualizado_em
       FROM plataforma.credencial_unidade
      WHERE tenant_id = $1 AND provedor = $2 AND tipo = $3`,
    [tenantId, provedor, tipo])).rows[0] || null);
}

/** Marca que a credencial foi usada com sucesso (diagnóstico de conta quebrada). */
async function marcarVerificada(tenantId, provedor, tipo) {
  await withTenant(tenantId, (c) => c.query(
    `UPDATE plataforma.credencial_unidade SET verificado_em = now()
      WHERE tenant_id = $1 AND provedor = $2 AND tipo = $3`,
    [tenantId, provedor, tipo]));
}

/** Derruba o cache: de uma credencial, de uma unidade inteira, ou de tudo. */
function invalidar(tenantId, provedor, tipo) {
  if (!tenantId) { _cache.clear(); return; }
  if (provedor && tipo) { _cache.delete(_chave(tenantId, provedor, tipo)); return; }
  for (const k of _cache.keys()) if (k.startsWith(`${tenantId}|`)) _cache.delete(k);
}

module.exports = {
  lerCredencial, gravarCredencial, revogarCredencial, pendentesNaOrigem, metadadosCredencial,
  marcarVerificada, invalidar, _cache, TTL_MS,
};
