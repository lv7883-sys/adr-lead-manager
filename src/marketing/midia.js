'use strict';
//
// midia.js — O CAMINHO DO ARQUIVO É DERIVADO DO TENANT, NUNCA DO QUE O USUÁRIO DIGITOU.
//
// A pasta de mídia é o lugar mais fácil de vazar dado entre clientes: basta um nome de
// arquivo com "../" para uma unidade escrever (ou ler) na pasta da outra. Por isso aqui:
//   • a raiz da unidade é montada a partir do uuid, que é validado contra regex;
//   • o nome do arquivo é reduzido ao básico (sem pasta, sem "..", sem caractere exótico);
//   • no fim, o caminho é CONFERIDO: se não estiver dentro da raiz da unidade, lança.
// E a mesma regra está no CHECK da tabela (migr. 143) — código e banco dizem a mesma coisa.
//
// path.posix de propósito: produção é Linux e o caminho gravado no banco precisa ser o
// mesmo venha de onde vier (a máquina de desenvolvimento é Windows).
//
const path = require('path');
const crypto = require('crypto');

const RAIZ = (process.env.ADR_MEDIA_ROOT || '/srv/adr-media').replace(/\/+$/, '');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Raiz da unidade: /srv/adr-media/<tenant_id>. Lança se o tenant não for um uuid. */
function raizDoTenant(tenantId) {
  if (!UUID_RE.test(String(tenantId || ''))) {
    const err = new Error('tenant inválido para caminho de mídia');
    err.code = 'MEDIA_TENANT_INVALIDO';
    throw err;
  }
  return path.posix.join(RAIZ, String(tenantId));
}

/**
 * Nome de arquivo seguro a partir de um nome sugerido (upload, legenda, API).
 * Mantém só letras, números, ponto, hífen e sublinhado; nunca devolve vazio, "." ou "..".
 */
function nomeSeguro(sugerido, { extensaoPadrao = '' } = {}) {
  const base = path.posix.basename(String(sugerido || '').replace(/\\/g, '/'));
  let limpo = base.normalize('NFKD').replace(/[^A-Za-z0-9._-]/g, '_').replace(/_{2,}/g, '_').slice(0, 120);
  limpo = limpo.replace(/^\.+/, '');                    // ".." e ".oculto" viram nome comum
  if (!limpo) limpo = crypto.randomBytes(8).toString('hex') + extensaoPadrao;
  return limpo;
}

/**
 * Caminho final do arquivo desta unidade. SEMPRE sob /srv/adr-media/<tenant_id>/.
 * `subpasta` é opcional e também é sanitizada (um nível, sem travessia).
 */
function caminhoMidia(tenantId, nomeSugerido, { subpasta = null } = {}) {
  const raiz = raizDoTenant(tenantId);
  const partes = [raiz];
  if (subpasta) partes.push(nomeSeguro(subpasta));
  partes.push(nomeSeguro(nomeSugerido));
  const destino = path.posix.normalize(partes.join('/'));
  // Conferência final: normalize() já resolveu qualquer "..", então se o resultado saiu
  // da raiz, alguma coisa acima falhou — e aqui a gente para, em vez de escrever fora.
  if (!dentroDaRaiz(tenantId, destino)) {
    const err = new Error('caminho de mídia fora da raiz da unidade');
    err.code = 'MEDIA_FORA_DA_RAIZ';
    throw err;
  }
  return destino;
}

/** O caminho pertence mesmo a esta unidade? (usar antes de LER um caminho vindo do banco) */
function dentroDaRaiz(tenantId, caminho) {
  let raiz;
  try { raiz = raizDoTenant(tenantId); } catch { return false; }
  const c = path.posix.normalize(String(caminho || ''));
  return c.startsWith(raiz + '/') && !c.includes('..');
}

module.exports = { caminhoMidia, raizDoTenant, dentroDaRaiz, nomeSeguro, RAIZ };
