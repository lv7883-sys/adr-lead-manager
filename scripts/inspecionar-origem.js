'use strict';
//
// inspect-referral.js — PROBE one-shot READ-ONLY: o `externalAdReply` chega mesmo nesta
// versão da Evolution API?
//
// Lê as N mensagens de ENTRADA mais recentes (messages.raw, o payload como o webhook o
// recebeu) e imprime a estrutura do contextInfo de cada uma: onde ele mora, quais chaves
// traz e o que o externalAdReply tem dentro. No fim, um resumo — quantas mensagens têm
// contextInfo, quantas têm externalAdReply, quantas trazem um código [XX] no fim do texto.
//
// É a prova ANTES da mídia paga entrar no ar: sem ver um externalAdReply real chegando,
// a atribuição de campanha é uma aposta.
//
// NUNCA escreve. Não roda em cron. Rodar à mão:
//   docker exec adr-lead-manager node /app/scripts/inspect-referral.js
//   docker exec adr-lead-manager node /app/scripts/inspect-referral.js --limit 200 --so-anuncio
//   docker exec adr-lead-manager node /app/scripts/inspect-referral.js --tenant <uuid> --json
//
// Opções:
//   --limit N       quantas mensagens ler por unidade (padrão 50)
//   --tenant <uuid> só esta unidade (padrão: todas as unidades ativas)
//   --so-anuncio    imprime só o que tem externalAdReply (o resumo continua contando tudo)
//   --json          uma linha JSON por mensagem, para mandar pro jq
//
const { pool, withTenant } = require('../src/db');
const origemLead = require('../src/origemLead');
const waConteudo = require('../src/waConteudo');

function args() {
  const a = process.argv.slice(2);
  const val = (nome, padrao) => {
    const i = a.indexOf(nome);
    return i >= 0 && a[i + 1] ? a[i + 1] : padrao;
  };
  return {
    limit: Math.max(1, Math.min(1000, Number(val('--limit', 50)) || 50)),
    tenant: val('--tenant', null),
    soAnuncio: a.includes('--so-anuncio'),
    json: a.includes('--json'),
  };
}

// Onde o contextInfo mora nesta mensagem, e o que ele traz. Devolve [{ caminho, chaves, ci }].
function contextInfos(message) {
  if (!message || typeof message !== 'object') return [];
  let inner;
  try { inner = waConteudo.desembrulhar(message).inner; } catch { inner = message; }
  if (!inner || typeof inner !== 'object') return [];
  const achados = [];
  if (inner.contextInfo && typeof inner.contextInfo === 'object') {
    achados.push({ caminho: 'contextInfo', chaves: Object.keys(inner.contextInfo), ci: inner.contextInfo });
  }
  for (const [k, v] of Object.entries(inner)) {
    if (k === 'contextInfo') continue;
    if (v && typeof v === 'object' && v.contextInfo && typeof v.contextInfo === 'object') {
      achados.push({ caminho: `${k}.contextInfo`, chaves: Object.keys(v.contextInfo), ci: v.contextInfo });
    }
  }
  return achados;
}

function tiposDaMensagem(message) {
  if (!message || typeof message !== 'object') return [];
  let inner;
  try { inner = waConteudo.desembrulhar(message).inner; } catch { inner = message; }
  return inner && typeof inner === 'object' ? Object.keys(inner) : [];
}

async function tenants(filtro) {
  if (filtro) return [filtro];
  const { rows } = await pool.query('SELECT tenant_id FROM tenants_active()');
  return rows.map((r) => r.tenant_id);
}

async function inspecionar(tenantId, opt, resumo) {
  const rows = await withTenant(tenantId, async (c) => (await c.query(
    `SELECT m.id, m.received_at, m.external_message_id, m.sender, m.body, m.raw,
            cv.external_id, cv.conversation_kind
       FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
      WHERE m.tenant_id = $1
        AND m.direction = 'inbound'
        AND coalesce(cv.conversation_kind, 'DIRECT') = 'DIRECT'
      ORDER BY m.received_at DESC
      LIMIT $2`,
    [tenantId, opt.limit])).rows);

  console.log(`\n=== unidade ${tenantId} — ${rows.length} mensagem(ns) de entrada ===`);
  for (const r of rows) {
    const message = (r.raw && r.raw.data && r.raw.data.message) || null;
    const cis = contextInfos(message);
    const anuncio = origemLead.extrairAnuncio(message);
    const codigo = origemLead.extrairCodigoCampanha(r.body);

    resumo.total += 1;
    if (cis.length) resumo.comContextInfo += 1;
    if (anuncio) resumo.comAdReply += 1;
    if (codigo) resumo.comCodigo += 1;
    if (!r.raw || !r.raw.data) resumo.semRawEvolution += 1;

    if (opt.soAnuncio && !anuncio) continue;

    if (opt.json) {
      console.log(JSON.stringify({
        received_at: r.received_at, external_id: r.external_id,
        tipos: tiposDaMensagem(message),
        context_info: cis.map((x) => ({ caminho: x.caminho, chaves: x.chaves })),
        external_ad_reply: anuncio,
        // o externalAdReply CRU — é aqui que aparece campo que ainda não lemos
        external_ad_reply_cru: cis.map((x) => x.ci.externalAdReply).find(Boolean) || null,
        codigo_campanha: codigo,
      }));
      continue;
    }

    const quando = new Date(r.received_at).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`\n[${quando}] ${r.external_id}  ${r.sender ? '(' + r.sender + ')' : ''}`);
    console.log(`  texto...: ${r.body == null ? '(sem texto)' : JSON.stringify(String(r.body).slice(0, 120))}`);
    console.log(`  tipos...: ${tiposDaMensagem(message).join(', ') || '(sem raw.data.message)'}`);
    if (!cis.length) {
      console.log('  contexto: (nenhum contextInfo)');
    } else {
      for (const x of cis) console.log(`  contexto: ${x.caminho} -> { ${x.chaves.join(', ')} }`);
    }
    const cru = cis.map((x) => x.ci.externalAdReply).find(Boolean);
    if (cru) {
      console.log('  ANÚNCIO : externalAdReply CRU:');
      console.log(JSON.stringify(cru, null, 2).split('\n').map((l) => '            ' + l).join('\n'));
      console.log(`            lido como: ${JSON.stringify(anuncio)}`);
    }
    if (codigo) console.log(`  CÓDIGO..: [${codigo}]`);
  }
}

async function main() {
  const opt = args();
  const resumo = { total: 0, comContextInfo: 0, comAdReply: 0, comCodigo: 0, semRawEvolution: 0 };
  const lista = await tenants(opt.tenant);
  if (!lista.length) {
    console.log('nenhuma unidade ativa (ou --tenant não informado).');
    return;
  }
  for (const t of lista) {
    try {
      await inspecionar(t, opt, resumo);
    } catch (e) {
      console.error(`[erro] unidade ${t}: ${e.message}`);
    }
  }
  console.log('\n=== RESUMO ===');
  console.log(`mensagens lidas.................: ${resumo.total}`);
  console.log(`com algum contextInfo...........: ${resumo.comContextInfo}`);
  console.log(`com externalAdReply (ANÚNCIO)...: ${resumo.comAdReply}`);
  console.log(`com código [XX] no fim do texto.: ${resumo.comCodigo}`);
  console.log(`sem raw.data (payload não-Evolution/histórico): ${resumo.semRawEvolution}`);
  if (!resumo.comAdReply) {
    console.log('\nNenhum externalAdReply nesta amostra. Isso NÃO prova que a Evolution não manda —');
    console.log('prova que ninguém clicou num anúncio Click-to-WhatsApp nas mensagens lidas. Rode de');
    console.log('novo depois do primeiro clique real, ou aumente --limit.');
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
