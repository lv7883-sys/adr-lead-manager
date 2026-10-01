'use strict';
//
// extranet-cache.js — guarda o que JÁ foi lido da Extranet, para que uma falha no meio de uma
// coleta de 11h não jogue fora as horas anteriores (incidente de 30/09/2026: "fetch failed" na
// décima hora descartou 651 min de trabalho).
//
// O QUE ELE NÃO É: não é gravar snapshot parcial no cadastro. A salvaguarda de queda continua
// valendo e o snapshot continua sendo montado completo. Isto aqui é a MATÉRIA-PRIMA (páginas já
// lidas), não o resultado.
//
// TRÊS REGRAS DE VALIDADE, nesta ordem:
//   1. ASSINATURA — a lista de contratos já traz curso, vigência, status e nome. Se a assinatura
//      mudou desde a última leitura, rebusca, sem esperar prazo. É o sinal mais forte que existe.
//   2. PRAZO COM DISPERSÃO — dado que muda SEM aparecer na lista (telefone, nascimento,
//      responsável) precisa ser revalidado. Prazo de 5 a 9 dias, escolhido pela própria chave:
//      se todas vencessem no mesmo dia, um dia por semana voltaria a ser a coleta de 11h.
//   3. AMOSTRAGEM DE VERIFICAÇÃO — uma fração das páginas válidas é rebuscada assim mesmo e
//      comparada com o que estava guardado. É o que impede o cache de mentir em silêncio: sem
//      isso, um campo que mudou de forma invisível ficaria errado por dias e ninguém saberia.
//
// Reversão: CADASTRO_CACHE=off faz tudo voltar ao comportamento antigo (buscar tudo, todo dia),
// sem tocar no banco.
//
const crypto = require('crypto');
const logger = require('../logger');

const LIGADO = String(process.env.CADASTRO_CACHE ?? 'on').toLowerCase() !== 'off';
const VALIDADE_MIN_DIAS = Number(process.env.CADASTRO_CACHE_DIAS_MIN ?? 5);
const VALIDADE_MAX_DIAS = Number(process.env.CADASTRO_CACHE_DIAS_MAX ?? 9);
// Fração das páginas VÁLIDAS que é rebuscada mesmo assim, só para conferir se o guardado ainda
// bate com a Extranet. 0 desliga a conferência (não recomendado: cache sem verificação mente).
const VERIFICA_FRAC = Number(process.env.CADASTRO_CACHE_VERIFICA ?? 0.05);

const DIA_MS = 86400000;

// Prazo por chave, determinístico: mesma chave sempre cai no mesmo dia da semana, chaves
// diferentes se espalham. Evita o "vence tudo junto" que traria a coleta de 11h de volta.
function validadeDias(chave, { min = VALIDADE_MIN_DIAS, max = VALIDADE_MAX_DIAS } = {}) {
  const faixa = Math.max(1, (max - min) + 1);
  const h = crypto.createHash('sha1').update(String(chave)).digest();
  return min + (h[0] % faixa);
}

// Sorteio estável por chave+dia: a mesma página não é verificada duas vezes no mesmo dia, e ao
// longo da semana o rodízio cobre gente diferente. Fração 0 → nunca; 1 → sempre.
function sorteadoParaVerificar(chave, frac = VERIFICA_FRAC, hoje = new Date()) {
  if (!(frac > 0)) return false;
  if (frac >= 1) return true;
  const dia = hoje.toISOString().slice(0, 10);
  const h = crypto.createHash('sha1').update(`${chave}|${dia}`).digest();
  return (h.readUInt16BE(0) / 65535) < frac;
}

function assinaturaDe(partes) {
  return partes.map((p) => (p == null ? '' : String(p))).join('|');
}

// Um cache por execução: carrega tudo de uma vez (a tabela tem ~1,5 mil linhas) e grava página a
// página, assim que cada uma chega — é a gravação imediata que dá a retomada.
function criarCache({ tenantId, query, ligado = LIGADO, verificaFrac = VERIFICA_FRAC, agora = () => new Date() } = {}) {
  const memoria = new Map();             // `${tipo}\u0000${chave}` → { assinatura, conteudo, buscado_em }
  const stats = { hits: 0, buscas: 0, expirados: 0, mudaram: 0, verificados: 0, divergencias: 0, gravados: 0 };
  const k = (tipo, chave) => `${tipo}\u0000${chave}`;
  let vivo = ligado;                     // vira false se o cache não estiver utilizável (ver carregar)

  // O cache é CONVENIÊNCIA, nunca requisito: se a tabela ainda não existe (código publicado antes
  // da migração 131) ou o SELECT falha, a coleta segue buscando tudo, como antes. Cache que
  // derruba a coleta seria pior que não ter cache.
  async function carregar(tipos) {
    if (!vivo) return;
    try {
      const r = await query(
        `SELECT tipo, chave, assinatura, conteudo, buscado_em
           FROM lead_manager.extranet_pagina_cache
          WHERE tenant_id = $1 AND tipo = ANY($2::text[])`, [tenantId, tipos]);
      for (const row of r.rows) memoria.set(k(row.tipo, row.chave), row);
    } catch (e) {
      vivo = false;
      logger.warn('extranet_cache.indisponivel', { tenant_id: tenantId, error: e.message, consequencia: 'coleta segue sem cache' });
    }
  }

  // Decide SEM efeito colateral: devolve { usar, conteudo, motivo, verificar }.
  //   usar=true      → aproveita o guardado;
  //   verificar=true → aproveita, mas rebusca para conferir (a chamada decide o que fazer).
  function consultar(tipo, chave, assinaturaAtual = null) {
    if (!vivo) return { usar: false, motivo: 'desligado' };
    const e = memoria.get(k(tipo, chave));
    if (!e) return { usar: false, motivo: 'inexistente' };
    if (assinaturaAtual != null && e.assinatura !== assinaturaAtual) {
      stats.mudaram++;
      return { usar: false, motivo: 'mudou-na-lista' };
    }
    const idade = agora() - new Date(e.buscado_em);
    if (idade > validadeDias(chave) * DIA_MS) {
      stats.expirados++;
      return { usar: false, motivo: 'vencido' };
    }
    if (sorteadoParaVerificar(chave, verificaFrac, agora())) {
      return { usar: true, conteudo: e.conteudo, motivo: 'verificacao', verificar: true };
    }
    stats.hits++;
    return { usar: true, conteudo: e.conteudo, motivo: 'valido' };
  }

  // Grava JÁ (não no fim do run): é isto que transforma 11h perdidas em minutos perdidos.
  // Nunca lança: falhar ao guardar matéria-prima não pode derrubar uma coleta que está indo bem.
  async function gravar(tipo, chave, assinatura, conteudo) {
    if (!vivo) return;
    const quando = agora();
    memoria.set(k(tipo, chave), { tipo, chave, assinatura, conteudo, buscado_em: quando });
    stats.gravados++;
    try {
      await query(
        `INSERT INTO lead_manager.extranet_pagina_cache (tenant_id, tipo, chave, assinatura, conteudo, buscado_em)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT (tenant_id, tipo, chave)
         DO UPDATE SET assinatura = EXCLUDED.assinatura, conteudo = EXCLUDED.conteudo, buscado_em = EXCLUDED.buscado_em`,
        [tenantId, tipo, chave, assinatura, JSON.stringify(conteudo), quando]);
    } catch (e) {
      logger.warn('extranet_cache.gravar_falhou', { tenant_id: tenantId, tipo, chave, error: e.message });
    }
  }

  // Compara o que estava guardado com o que a Extranet acabou de devolver. Divergência não quebra
  // a coleta (o valor novo é o que vale); ela vira log de alta visibilidade, porque significa que
  // o prazo de validade está frouxo demais para aquele tipo de página.
  function conferir(tipo, chave, guardado, novo) {
    stats.verificados++;
    const campos = [...new Set([...Object.keys(guardado || {}), ...Object.keys(novo || {})])];
    const diferentes = campos.filter((c) => JSON.stringify((guardado || {})[c] ?? null) !== JSON.stringify((novo || {})[c] ?? null));
    if (diferentes.length) {
      stats.divergencias++;
      logger.warn('extranet_cache.divergencia', { tenant_id: tenantId, alert: true, tipo, chave, campos: diferentes });
    }
    return diferentes;
  }

  return { carregar, consultar, gravar, conferir, stats, get ligado() { return vivo; } };
}

module.exports = { criarCache, validadeDias, sorteadoParaVerificar, assinaturaDe, LIGADO };
