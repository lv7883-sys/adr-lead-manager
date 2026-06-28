'use strict';

// scrape-extranet.js — ADAPTER de dispatch da fonte SCRAPE_EXTRANET (ADR-026 §2.4).
// Cola: binding (credencial cifrada) → extranet-client (login/sessão/throttle) →
// valinhos (fetch+parse) → ResourceSnapshot genérico. É o que o runner chama p/
// kind='SCRAPE_EXTRANET'. ESPECÍFICO da fonte (camada de adapter) — o core não o conhece.

const crypto = require('../../crypto');
const client = require('./extranet-client');
const valinhos = require('./valinhos');

// produce(binding, { destDir }) → ResourceSnapshot. Decifra a credencial do binding
// (Opção A: LM_ENCRYPTION_KEY), monta o transporte autenticado e bate na fonte.
// PRESSUPÕE estar sob o pg_advisory_lock (responsabilidade do runner) — todo o acesso
// à Extranet (login + fetch) acontece aqui dentro.
async function produce(binding, { destDir } = {}) {
  const cfg = binding.config || {};
  const senha = crypto.decrypt(cfg.credential_enc); // só em memória; nunca a log/disco
  if (!senha) throw new Error('scrape-extranet: credencial vazia/indecifrável no binding');

  const creds = { email: cfg.email, senha, perfil: cfg.perfil, unidade: cfg.unidade };
  const transport = client.transportFor(creds);     // resolve sessão (disco/login) + re-login 1x
  const dirs = await valinhos.fetch(transport, { destDir });
  return valinhos.parse(dirs);                        // ResourceSnapshot genérico
}

module.exports = { kind: 'SCRAPE_EXTRANET', produce };
