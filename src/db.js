'use strict';

const { Pool } = require('pg');

// Pool compartilhado. O search_path do lead_manager_user já aponta para
// o schema lead_manager (ALTER ROLE na migration 001).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/**
 * Executa `fn` dentro de uma transação com o contexto de tenant ativo.
 *
 * Usa `SET LOCAL app.current_tenant` — escopo de transação, então a
 * variável é descartada automaticamente no COMMIT/ROLLBACK e nunca
 * "vaza" para a próxima requisição que reutilizar a conexão do pool.
 * Esse é o contexto em que as políticas de RLS confiam.
 *
 * @param {string} tenantId  UUID do tenant (vindo da URL do webhook).
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTenant(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config(name, value, is_local=true) = SET LOCAL, com parâmetro
    // bindável (evita qualquer injeção via tenantId).
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTenant };
