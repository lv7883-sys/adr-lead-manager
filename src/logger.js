'use strict';

// Logger estruturado (JSON em uma linha por evento). Todos os campos de
// contexto — em especial tenant_id e conversation_id — viajam junto do
// evento para facilitar busca/correlação em qualquer agregador de logs.

function emit(level, event, fields) {
  const line = {
    ts: new Date().toISOString(),
    level,
    service: 'adr-lead-manager',
    event,
    // Garante presença das chaves de correlação, mesmo que null.
    tenant_id: fields.tenant_id ?? null,
    conversation_id: fields.conversation_id ?? null,
    ...fields,
  };
  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

module.exports = {
  info: (event, fields = {}) => emit('info', event, fields),
  warn: (event, fields = {}) => emit('warn', event, fields),
  error: (event, fields = {}) => emit('error', event, fields),
  // Cria um logger "filho" com contexto fixo (ex.: tenant_id da request).
  child: (base = {}) => ({
    info: (event, fields = {}) => emit('info', event, { ...base, ...fields }),
    warn: (event, fields = {}) => emit('warn', event, { ...base, ...fields }),
    error: (event, fields = {}) => emit('error', event, { ...base, ...fields }),
  }),
};
