'use strict';
//
// licenca.js — O ÚNICO PONTO que responde "esta unidade contratou este módulo?".
//
// Substitui a chave de liga/desliga no ambiente: uma variável MODULO_X_ENABLED=true liga o
// módulo para TODAS as unidades que rodam naquele processo, porque ambiente é do PROCESSO.
// Contratação é da UNIDADE: quem assinou tem; quem não assinou, não tem; quem foi suspenso
// perde na hora, sem nova publicação de código.
//
// FONTE ÚNICA (decisão do Leo, 20/09/2026): `plataforma.assinatura`, do ADR-051 (D9).
// Ela ainda não existe. Até existir, a resposta vem de `app.tenant_modules` (schema do
// Scheduler), ligada à unidade por `app.franquia.lead_tenant_id`.
//
//   ⚠ NENHUM outro arquivo consulta tabela de contratação. É de propósito: quando a Fase 6
//   do ADR-051 virar a chave, muda UMA consulta aqui — `_lerContratacao()` — e não N
//   chamadores espalhados. A virada tem de ser precedida da comparação linha a linha entre
//   o que `app.tenant_modules` e `tenant_subscriptions` dizem hoje e o que a `assinatura`
//   passará a dizer.
//
// Uso na rota:      router.post('/x', exigirModulo('MARKETING'), handler)
// Uso na rotina:    await garantirModulo(tenantId, 'MARKETING')   // lança se não tem
// Uso em varredura: await moduloAtivo(tenantId, 'MARKETING')      // true/false
//
const { withTenant } = require('../db');
const logger = require('../logger');

// Situações que dão acesso (vocabulário fechado com o ADR-051: teste, ativa, em_atraso,
// suspensa, cancelada, inexistente). 'suspensa', 'em_atraso' e 'cancelada' NÃO dão — e essa é a diferença entre
// um produto que se vende e um que se liga com publicação de código.
const SITUACOES_COM_ACESSO = new Set(['ativa', 'teste']);

/**
 * A ÚNICA consulta de contratação do Lead Manager.
 *
 * HOJE: `app.tenant_modules` (active booleano, sem prazo) normalizada para o formato que a
 * `plataforma.contratado(unidade, aplicacao)` vai devolver amanhã — { situacao, expira_em,
 * plano, fonte }, assinatura fechada com a sessão do ADR-051 em 20/09. Assim a
 * troca da fonte não muda o contrato de quem chama.
 *
 * `app.tenant_modules` não tem RLS (é do Scheduler), então o filtro por unidade é explícito
 * e obrigatório aqui: `f.lead_tenant_id = $1`.
 */
async function _lerContratacao(tenantId, moduloCodigo) {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT tm.active, tm.activated_at
         FROM app.tenant_modules tm
         JOIN app.franquia f ON f.id = tm.franquia_id
        WHERE f.lead_tenant_id = $1 AND tm.module = $2
        LIMIT 1`,
      [tenantId, moduloCodigo]);
    if (!r.rows[0]) return { situacao: 'inexistente', expira_em: null, plano: null, fonte: 'app.tenant_modules' };
    return {
      situacao: r.rows[0].active ? 'ativa' : 'suspensa',
      expira_em: null,                       // app.tenant_modules não tem prazo; assinatura terá
      plano: null,
      contratado_em: r.rows[0].activated_at,
      fonte: 'app.tenant_modules',           // aparece no log: dá para auditar a virada
    };
  });
}

/**
 * DECISÃO PURA (sem banco, testável): esta contratação dá acesso agora?
 * @param {?{situacao: string, expira_em: ?(Date|string)}} linha
 * @param {Date} agora
 * @returns {{permitido: boolean, motivo: string}}
 */
function _decidir(linha, agora = new Date()) {
  if (!linha) return { permitido: false, motivo: 'sem_contratacao' };
  if (!SITUACOES_COM_ACESSO.has(linha.situacao)) return { permitido: false, motivo: `situacao_${linha.situacao}` };
  if (linha.expira_em != null) {
    const fim = linha.expira_em instanceof Date ? linha.expira_em : new Date(linha.expira_em);
    if (!(fim > agora)) return { permitido: false, motivo: 'contratacao_vencida' };
  }
  return { permitido: true, motivo: linha.situacao };
}

/**
 * Contratação da unidade, ou null. Erro de leitura NÃO vira "não contratou" silencioso:
 * propaga, e quem chama decide (a rota fecha com 503; a fila pula a unidade e loga).
 */
async function carregarContratacao(tenantId, moduloCodigo) {
  if (!tenantId || !moduloCodigo) return null;
  return _lerContratacao(tenantId, moduloCodigo);
}

/** true/false — para varreduras que precisam pular unidades sem o módulo. */
async function moduloAtivo(tenantId, moduloCodigo, agora = new Date()) {
  const linha = await carregarContratacao(tenantId, moduloCodigo);
  return _decidir(linha, agora).permitido;
}

/**
 * Para rotinas e trabalhadores: lança se a unidade não tem o módulo vigente.
 * Devolve a contratação quando tem.
 */
async function garantirModulo(tenantId, moduloCodigo, agora = new Date()) {
  const linha = await carregarContratacao(tenantId, moduloCodigo);
  const d = _decidir(linha, agora);
  if (!d.permitido) {
    const err = new Error(`unidade sem acesso a ${moduloCodigo}: ${d.motivo}`);
    err.code = 'MODULO_NAO_CONTRATADO';
    err.motivo = d.motivo;
    throw err;
  }
  return linha;
}

/**
 * Middleware de rota. Exige que a unidade já tenha sido resolvida pela autenticação
 * (req.tenant.id ou req.params.tenantId) — este middleware NÃO autentica, só confere a
 * contratação. 402 (pagamento necessário) é deliberado: "existe, mas esta unidade não
 * contratou" é diferente de 403 (autenticado e proibido) e de 404 (não existe).
 */
function exigirModulo(moduloCodigo) {
  return async function _exigirModulo(req, res, next) {
    const tenantId = (req.tenant && req.tenant.id) || req.params.tenantId || null;
    if (!tenantId) return res.status(401).json({ error: 'unidade não resolvida' });
    try {
      const linha = await carregarContratacao(tenantId, moduloCodigo);
      const d = _decidir(linha, new Date());
      if (!d.permitido) {
        (req.log || logger).info('contratacao.negada', { tenant_id: tenantId, modulo: moduloCodigo, motivo: d.motivo });
        return res.status(402).json({ error: 'módulo não contratado', modulo: moduloCodigo, motivo: d.motivo });
      }
      req.contratacao = { modulo: moduloCodigo, situacao: linha.situacao, plano: linha.plano };
      return next();
    } catch (e) {
      (req.log || logger).error('contratacao.erro', { tenant_id: tenantId, modulo: moduloCodigo, error: e.message });
      // Falha ao LER a contratação NÃO libera o módulo: fecha.
      return res.status(503).json({ error: 'não foi possível verificar a contratação' });
    }
  };
}

module.exports = {
  exigirModulo, garantirModulo, moduloAtivo, carregarContratacao,
  _decidir, _lerContratacao, SITUACOES_COM_ACESSO,
};
