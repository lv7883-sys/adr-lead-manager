'use strict';

// extranet-lock.js — SERIALIZAÇÃO de acesso à Extranet entre PROCESSOS/APPS distintos
// (ADR-026 §2.4). Infra GENÉRICA (não conhece adapter/fonte): qualquer caminho que vá
// bater na Extranet roda dentro de withExtranetLock().
//
// MECANISMO: pg_advisory_lock no Postgres COMPARTILHADO (adr_scheduler). O scheduler
// (adr-dashboard) usa o MESMO lock (dashboard/lib/extranet-lock.js), então só UM dos
// dois apps acessa a Extranet por vez — defesa contra 429 por concorrência.
//
// CHAVE: hashtext('extranet-access') = 2037495811. Calculada no servidor compartilhado;
// como ambos os apps batem no MESMO Postgres, o número é idêntico nos dois lados. Usamos
// o literal (documentado) pra não depender da estabilidade de hashtext entre versões.
//
// O lock é de SESSÃO (pg_advisory_lock), tomado numa conexão DEDICADA do pool e solto
// em finally — nunca fica preso se o trabalho falhar. lock_timeout faz a AQUISIÇÃO
// esperar com teto: se o outro app está acessando, espera até timeoutMs e então lança
// (o chamador decide recuar) em vez de bater junto.

const { pool } = require('../db');

const LOCK_KEY = 2037495811; // hashtext('extranet-access') — ver dashboard/lib/extranet-lock.js
const DEFAULT_TIMEOUT_MS = 120000; // 2min: espera sensata pela liberação do outro app

// Kill-switch operacional: EXTRANET_ADVISORY_LOCK=0 desliga a serialização sem redeploy
// (escape hatch se o lock causar problema em produção). Default LIGADO.
const ENABLED = process.env.EXTRANET_ADVISORY_LOCK !== '0';

/**
 * Roda `fn` segurando o lock advisory de acesso à Extranet. Pega antes, solta depois
 * (try/finally). Se não conseguir o lock em até timeoutMs, lança (lock_timeout).
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<T>}
 */
async function withExtranetLock(fn, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!ENABLED) return fn();

  const client = await pool.connect();
  let held = false;
  try {
    // lock_timeout limita a ESPERA pela aquisição (set_config local=false = sessão).
    await client.query("SELECT set_config('lock_timeout', $1, false)", [String(Math.max(0, timeoutMs))]);
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]); // lança em timeout
    held = true;
    return await fn();
  } finally {
    if (held) {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    }
    client.release();
  }
}

module.exports = { withExtranetLock, LOCK_KEY };
