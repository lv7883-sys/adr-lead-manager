'use strict';
//
// latencia-ingestao.js — QUANTO TEMPO ENTRE A MENSAGEM CHEGAR E O LEAD EXISTIR? (READ-ONLY)
//
// Este script existe para responder UMA pergunta, pedida pelo Leo em 16/11/2026, e que até agora
// ninguém no projeto conseguia responder com número: dá para avisar a recepção "no instante" em
// que um lead chega? (docs/proposta-aviso-lead-novo.md, D2.)
//
// A medição vem da tabela lead_manager.ingestao_latencia (migr 192), gravada pelo webhook.
//
// COMO LER O QUE ELE IMPRIME — e isto importa mais que os números:
//
//   • "lead novo" é a única linha que decide o desenho. Mensagem de aluno ou de fornecedor
//     também passa pelo funil, mas não há nada a avisar: misturar as duas afunda a mediana e
//     responde a pergunta errada.
//   • p50 é o caso comum; p95 é o que a recepção vai LEMBRAR. Se o p50 for 3 s e o p95 for 40 s,
//     o aviso "no instante" não existe — existe um aviso rápido quase sempre.
//   • "fila" mede Evolution + despachante, comparando o relógio do WhatsApp com o nosso. Relógio
//     de máquina diferente discorda: o script DESCARTA o implausível e diz quantos descartou, em
//     vez de embutir desvio de relógio na conta.
//   • ZERO LINHAS NÃO É "ESTÁ RÁPIDO". É "não mediu" — tabela ausente, migração não aplicada,
//     privilégio faltando ou nenhuma mensagem no período. O script grita isso em vez de imprimir
//     um painel vazio e tranquilizador.
//
// NUNCA escreve. Rodar à mão:
//   make latencia-ingestao
//   docker exec adr-lead-manager node /app/scripts/latencia-ingestao.js
//   docker exec adr-lead-manager node /app/scripts/latencia-ingestao.js --dias 3 --json
//
// Opções:
//   --tenant <uuid>  só esta unidade (padrão: todas as unidades ativas)
//   --dias N         janela (padrão 7)
//   --json           uma linha JSON por unidade
//
const { pool, withTenant } = require('../src/db');
const { resumir } = require('../src/ingestaoLatencia');

function args() {
  const a = process.argv.slice(2);
  const val = (nome, padrao) => {
    const i = a.indexOf(nome);
    return i >= 0 && a[i + 1] ? a[i + 1] : padrao;
  };
  return {
    tenant: val('--tenant', null),
    dias: Math.max(1, Math.min(365, Number(val('--dias', 7)) || 7)),
    json: a.includes('--json'),
  };
}

// Enumerar unidades é cross-tenant e a RLS (com razão) não deixa: função SECURITY DEFINER que as
// rotinas da casa já usam. O nome vem depois, dentro do contexto de cada unidade.
async function unidades(filtro) {
  if (filtro) return [filtro];
  const { rows } = await pool.query('SELECT tenant_id FROM lead_manager.tenants_active()');
  return rows.map((r) => r.tenant_id);
}

async function nomeDaUnidade(tenantId) {
  try {
    return await withTenant(tenantId, async (c) => (await c.query(
      'SELECT name FROM tenants WHERE id = $1', [tenantId])).rows[0]?.name) || '(sem nome)';
  } catch { return '(sem nome)'; }
}

async function lerLinhas(tenantId, dias) {
  return withTenant(tenantId, async (c) => (await c.query(
    `SELECT total_ms, funil_ms, midia_ms, fila_ms, origem_ms, lead_novo, tem_midia, tipo_midia
       FROM ingestao_latencia
      WHERE recebido_em >= now() - ($1 || ' days')::interval
      ORDER BY recebido_em DESC`, [String(dias)])).rows);
}

const seg = (ms) => (ms == null ? '   —  ' : `${(ms / 1000).toFixed(1)}s`.padStart(6));

function imprimir(nome, dias, r) {
  console.log('');
  console.log(`═══ ${nome} — últimos ${dias} dia(s) ═══`);
  console.log(`  mensagens processadas: ${r.mensagens}   |   viraram lead NOVO: ${r.leads_novos}   |   com mídia: ${r.com_midia}`);

  if (!r.mensagens) {
    console.log('  ⚠ ZERO LINHAS. Isto NÃO quer dizer "está rápido" — quer dizer que não mediu.');
    console.log('    Confira, nesta ordem: a migração 192 foi aplicada? o GRANT para lead_manager_user existe?');
    console.log('    MEDIR_LATENCIA_INGESTAO está "off"? houve mensagem de entrada no período?');
    console.log('    (O log do contêiner registra "latencia.nao_gravou" com a causa, uma vez por causa.)');
    return;
  }

  const linha = (rotulo, f) => console.log(
    `  ${rotulo.padEnd(34)} n=${String(f.n).padStart(5)}   p50 ${seg(f.p50)}   p90 ${seg(f.p90)}   p95 ${seg(f.p95)}   máx ${seg(f.max)}`);

  console.log('');
  console.log('  ▸ A PERGUNTA QUE DECIDE — mensagem chega → lead novo existe:');
  linha('total (webhook → lead existe)', r.total_lead_novo);
  linha('  dentro dele: o funil/IA', r.funil_lead_novo);
  if (!r.leads_novos) {
    console.log('    ⚠ nenhum lead novo no período: a linha acima não tem base. Amplie --dias.');
  }
  console.log('');
  console.log('  ▸ Contexto (toda mensagem, virando lead ou não):');
  linha('total de todas as mensagens', r.total_todas);
  linha('baixar mídia + transcrever', r.midia_todas);
  linha('fila: envio → nosso servidor', r.fila);
  if (r.fila.descartadas_por_relogio > 0) {
    console.log(`    (descartei ${r.fila.descartadas_por_relogio} medição(ões) de fila por desvio de relógio — ver o cabeçalho)`);
  }
  console.log('');
  const p95 = r.total_lead_novo.p95;
  if (p95 != null) {
    console.log(p95 <= 5000
      ? '  → p95 até 5s: avisar só no fim do funil entrega "no instante" de verdade.'
      : '  → p95 acima de 5s: avisar só no fim NÃO é "no instante". Ver §D2c da proposta (aviso em dois tempos).');
  }
}

(async () => {
  const a = args();
  let falhou = false;
  try {
    for (const tenantId of await unidades(a.tenant)) {
      const nome = await nomeDaUnidade(tenantId);
      let linhas;
      try {
        linhas = await lerLinhas(tenantId, a.dias);
      } catch (e) {
        falhou = true;
        // Erro de leitura é diferente de "sem dado", e confundir os dois é como esta medição
        // morreria calada: tabela inexistente imprimiria "0 mensagens" e pareceria resposta.
        console.error(`✗ ${nome}: não consegui LER a medição (${e.code || e.message}). Isto não é "zero mensagens".`);
        continue;
      }
      const r = resumir(linhas);
      if (a.json) console.log(JSON.stringify({ tenant_id: tenantId, unidade: nome, dias: a.dias, ...r }));
      else imprimir(nome, a.dias, r);
    }
  } finally {
    await pool.end();
  }
  process.exit(falhou ? 1 : 0);
})();
