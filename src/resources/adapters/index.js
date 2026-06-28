'use strict';

// adapters/index.js — REGISTRY de adapters por `kind` (ADR-026 §2.1/§2.4). Ponto de
// extensão EXPLÍCITO: o runner despacha por kind sem conhecer a fonte. Hoje só
// SCRAPE_EXTRANET (Valinhos, momento 0). Os outros momentos entram aqui SEM reescrever
// o runner:
//   - kind='API'    → momento 1 (outras franquias por API). NÃO implementado.
//   - kind='NATIVE' → momento 2 (tenants sem Extranet, recurso nativo). NÃO implementado.
//
// Contrato de cada adapter: { kind, produce(binding, { destDir }) → Promise<ResourceSnapshot> }.

const scrapeExtranet = require('./scrape-extranet');

const REGISTRY = {
  [scrapeExtranet.kind]: scrapeExtranet,
  // API:    require('./api')    — momento 1
  // NATIVE: require('./native') — momento 2
};

/** Resolve o adapter de um kind, ou null se não há suporte (ainda). */
function forKind(kind) {
  return REGISTRY[kind] || null;
}

/**
 * Sugestão GENÉRICA de capabilities por vocação de sala, despachada por kind.
 * O de-para vocação→caps é específico da fonte (mora no adapter); aqui só roteamos.
 * Adapter inexistente ou sem o método → [] (default seguro: sem sugestão).
 * @returns {string[]} refs de capability (cap:*) — a rota resolve p/ caps do tenant.
 */
function suggestRoomCaps(kind, vocacao) {
  const adapter = forKind(kind);
  if (adapter && typeof adapter.suggestRoomCaps === 'function') {
    return adapter.suggestRoomCaps(vocacao) || [];
  }
  return [];
}

module.exports = { forKind, REGISTRY, suggestRoomCaps };
