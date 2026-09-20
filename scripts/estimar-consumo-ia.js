'use strict';
//
// estimar-consumo-ia.js — QUANTAS CHAMADAS DE IA uma unidade consome, a partir do que já
// está no banco. READ-ONLY. Não escreve nada, não chama o Google, não custa nada.
//
// POR QUÊ ESTIMAR EM VEZ DE MEDIR
//   A medição exata (plataforma.consumo_evento) só vale daqui para frente, e a pergunta é
//   hoje: quanto uma unidade consome, e a que distância estamos do teto do Google? O banco
//   já sabe responder por dedução — cada evento registrado dispara um número CONHECIDO de
//   chamadas de IA, contado lendo o código do funil.
//
//   O que o teto do Google conta é REQUISIÇÃO POR MINUTO, por projeto, e o projeto é
//   compartilhado com o painel. Por isso este script imprime o PICO por minuto e por hora,
//   não só o total do mês: é o pico que derruba, não a média.
//
//   docker exec adr-lead-manager node /app/scripts/estimar-consumo-ia.js
//   docker exec adr-lead-manager node /app/scripts/estimar-consumo-ia.js --dias 90 --unidades 20
//   docker exec adr-lead-manager node /app/scripts/estimar-consumo-ia.js --tenant <uuid>
//
const { pool, withTenant } = require('../src/db');
const { CUSTO_PADRAO_BRL, TIPOS } = require('../src/plataforma/consumo');

// Chamadas de IA por evento — contadas em src/engine.js e src/autoReply.js (20/09/2026).
// Mudou o funil? Corrija aqui, senão a estimativa mente em silêncio.
const CHAMADAS_POR_EVENTO = {
  // toda mensagem de entrada 1:1 passa pelo Portão 1 (classify) OU pelo bloco de conversa
  // estabelecida (classifyConversa). Uma chamada, de um jeito ou de outro.
  mensagem_entrada: 1,
  // áudio recebido: transcrição antes do funil (gemini.transcribeAudio)
  audio_entrada: 1,
  // lead que entra no Portão 2: extractQualification + generateReply + classifyIntent
  lead_novo: 3,
  // rascunho gerado fora do Portão 2 (retomada, reprocessamento): generateReply
  rascunho: 1,
};

const VALINHOS = 'ed731a58-62e5-45ad-acba-a5502ff39e92';

function args() {
  const a = process.argv.slice(2);
  const val = (n, p) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] ? a[i + 1] : p; };
  return {
    tenant: val('--tenant', VALINHOS),
    dias: Math.max(1, Number(val('--dias', 30)) || 30),
    unidades: Math.max(1, Number(val('--unidades', 10)) || 10),
  };
}

async function contar(tenantId, dias) {
  return withTenant(tenantId, async (c) => {
    const janela = `now() - make_interval(days => ${Number(dias)})`;
    const um = async (sql, params = []) => Number((await c.query(sql, params)).rows[0].n || 0);

    // Mensagens de ENTRADA 1:1 (grupo não passa pelo funil de lead)
    const mensagens = await um(
      `SELECT count(*)::bigint AS n
         FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
        WHERE m.tenant_id = $1 AND m.direction = 'inbound'
          AND coalesce(cv.conversation_kind, 'DIRECT') = 'DIRECT'
          AND m.received_at >= ${janela}`, [tenantId]);

    const audios = await um(
      `SELECT count(*)::bigint AS n
         FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
        WHERE m.tenant_id = $1 AND m.direction = 'inbound' AND m.media_type = 'audio'
          AND coalesce(cv.conversation_kind, 'DIRECT') = 'DIRECT'
          AND m.received_at >= ${janela}`, [tenantId]);

    const leads = await um(
      `SELECT count(*)::bigint AS n FROM leads
        WHERE tenant_id = $1 AND created_at >= ${janela}`, [tenantId]);

    const rascunhos = await um(
      `SELECT count(*)::bigint AS n FROM pending_approvals
        WHERE tenant_id = $1 AND created_at >= ${janela}`, [tenantId]);

    // PICO: o teto do Google é por minuto. Usamos a entrada como proxy — é ela que dispara
    // o funil. Um minuto com 12 mensagens vira ~12 chamadas no mesmo minuto.
    const picoMinuto = await um(
      `SELECT coalesce(max(n), 0)::bigint AS n FROM (
         SELECT count(*) AS n FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
          WHERE m.tenant_id = $1 AND m.direction = 'inbound'
            AND coalesce(cv.conversation_kind, 'DIRECT') = 'DIRECT'
            AND m.received_at >= ${janela}
          GROUP BY date_trunc('minute', m.received_at)) x`, [tenantId]);

    const picoHora = await um(
      `SELECT coalesce(max(n), 0)::bigint AS n FROM (
         SELECT count(*) AS n FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
          WHERE m.tenant_id = $1 AND m.direction = 'inbound'
            AND coalesce(cv.conversation_kind, 'DIRECT') = 'DIRECT'
            AND m.received_at >= ${janela}
          GROUP BY date_trunc('hour', m.received_at)) x`, [tenantId]);

    return { mensagens, audios, leads, rascunhos, picoMinuto, picoHora };
  });
}

function linha(rotulo, valor, sufixo = '') {
  console.log(`  ${String(rotulo).padEnd(34)} ${String(valor).padStart(10)} ${sufixo}`);
}

async function main() {
  const o = args();
  const e = await contar(o.tenant, o.dias);

  const chamadas = {
    'triagem (1 por mensagem)': e.mensagens * CHAMADAS_POR_EVENTO.mensagem_entrada,
    'transcrição (1 por áudio)': e.audios * CHAMADAS_POR_EVENTO.audio_entrada,
    'funil do lead (3 por lead)': e.leads * CHAMADAS_POR_EVENTO.lead_novo,
    'rascunho (1 cada)': e.rascunhos * CHAMADAS_POR_EVENTO.rascunho,
  };
  const total = Object.values(chamadas).reduce((s, n) => s + n, 0);
  const porDia = total / o.dias;
  const porMes = porDia * 30;

  // Custo: tabela interna de CUSTO_PADRAO_BRL — PONTO DE PARTIDA, não o preço do Google.
  // Toda chamada é precificada como texto; a transcrição, que o Google cobra por segundo de
  // áudio, está subestimada aqui de propósito (não temos a duração gravada).
  const custoMes = porMes * CUSTO_PADRAO_BRL[TIPOS.IA_TEXTO];

  console.log(`\n=== CONSUMO DE IA — unidade ${o.tenant} — últimos ${o.dias} dias ===\n`);
  console.log('EVENTOS NO BANCO');
  linha('mensagens de entrada (1:1)', e.mensagens);
  linha('áudios recebidos', e.audios);
  linha('leads criados', e.leads);
  linha('rascunhos gerados', e.rascunhos);

  console.log('\nCHAMADAS DE IA ESTIMADAS');
  for (const [k, v] of Object.entries(chamadas)) linha(k, v);
  linha('TOTAL', total);
  linha('por dia', porDia.toFixed(1));
  linha('por mês (30 dias)', Math.round(porMes));
  linha('custo/mês estimado', `R$ ${custoMes.toFixed(2)}`, '(tabela interna, NÃO o preço do Google)');

  console.log('\nPICO — é isto que estoura o teto por minuto, não a média');
  linha('pico de mensagens num minuto', e.picoMinuto, `→ ~${e.picoMinuto} chamadas/min`);
  linha('pico de mensagens numa hora', e.picoHora);

  console.log(`\nEXTRAPOLAÇÃO PARA ${o.unidades} UNIDADES IGUAIS A ESTA`);
  linha('chamadas/mês', Math.round(porMes * o.unidades));
  linha('custo/mês estimado', `R$ ${(custoMes * o.unidades).toFixed(2)}`);
  linha('pico simultâneo (se coincidirem)', e.picoMinuto * o.unidades, 'chamadas/min');
  console.log(`\n  ⚠ O teto do Gemini é por PROJETO e por MINUTO, e o projeto é o mesmo do painel.`);
  console.log(`    Compare "${e.picoMinuto * o.unidades} chamadas/min" com o limite do seu plano no Google AI Studio.`);
  console.log(`    O pico real será MENOR (as unidades não recebem tudo no mesmo minuto) e MAIOR nas`);
  console.log(`    rotinas noturnas em lote, que não aparecem nesta conta.\n`);
  console.log('  Esta é uma ESTIMATIVA deduzida dos eventos do banco. A medição exata começa');
  console.log('  quando registrarUso() estiver ligado nas chamadas de IA (dívida A7).\n');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
