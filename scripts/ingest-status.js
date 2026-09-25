'use strict';
//
// ingest-status.js — A INGESTÃO DE MÍDIA ESTÁ VIVA? (READ-ONLY)
//
// Uma captura que roda no webhook falha em silêncio por natureza: ninguém abre um chamado
// dizendo "a foto que mandei no grupo não virou post". Este é o painel que responde, por
// unidade, as únicas perguntas que importam:
//
//   • o grupo está configurado como fonte?  (sem isso, nada entra — e é a causa #1)
//   • quantas mídias entraram este mês, e quanto ainda cabe na cota?
//   • quantas foram RECUSADAS, e por quê?   (cota estourada / download falhou)
//   • quando foi a última?                   (silêncio longo = algo quebrou)
//   • os arquivos estão mesmo no disco?      (linha no banco sem arquivo = mentira)
//
// NUNCA escreve. Rodar à mão:
//   make ingest-status
//   docker exec adr-lead-manager node /app/scripts/ingest-status.js
//   docker exec adr-lead-manager node /app/scripts/ingest-status.js --tenant <uuid> --json
//
// Opções:
//   --tenant <uuid>  só esta unidade (padrão: todas as unidades ativas)
//   --dias N         janela das recusas recentes (padrão 7)
//   --json           uma linha JSON por unidade, para mandar pro jq
//
const fs = require('node:fs');
const { pool, withTenant } = require('../src/db');
const ingestao = require('../src/marketing/ingestao');
const licenca = require('../src/plataforma/licenca');

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

// Enumerar unidades é cross-tenant e a RLS (com razão) não deixa: por isso a função
// SECURITY DEFINER que as rotinas já usam. O NOME vem depois, dentro do contexto de cada
// unidade — mesmo padrão do resto da casa.
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

/** Tudo o que sabemos sobre a ingestão desta unidade. Uma ida ao banco, no contexto dela. */
async function panorama(tenantId, dias) {
  return withTenant(tenantId, async (c) => {
    const grupos = (await c.query(
      `SELECT jid, nome, ativo FROM marketing.grupo_fonte
        WHERE tenant_id = $1 ORDER BY ativo DESC, nome`, [tenantId])).rows;

    const cota = ((await c.query(
      'SELECT cota FROM marketing.config_unidade WHERE tenant_id = $1', [tenantId])).rows[0] || {}).cota || {};

    const mes = (await c.query(
      `SELECT situacao, count(*)::int AS n
         FROM marketing.raw_asset
        WHERE tenant_id = $1 AND criado_em >= date_trunc('month', now())
        GROUP BY situacao`, [tenantId])).rows;

    const ultima = (await c.query(
      `SELECT criado_em, tipo, remetente_nome, situacao
         FROM marketing.raw_asset
        WHERE tenant_id = $1 ORDER BY criado_em DESC LIMIT 1`, [tenantId])).rows[0] || null;

    const recusas = (await c.query(
      `SELECT situacao, motivo, count(*)::int AS n, max(criado_em) AS ultima
         FROM marketing.raw_asset
        WHERE tenant_id = $1 AND situacao <> 'pendente_curadoria'
          AND criado_em >= now() - make_interval(days => $2::int)
        GROUP BY situacao, motivo ORDER BY n DESC LIMIT 10`, [tenantId, dias])).rows;

    // Amostra para conferir o disco: linha aceita PRECISA ter o arquivo lá. Banco dizendo
    // "guardei" com a pasta vazia é o pior dos mundos — parece saudável e não é.
    const amostra = (await c.query(
      `SELECT id, caminho FROM marketing.raw_asset
        WHERE tenant_id = $1 AND situacao = 'pendente_curadoria' AND caminho IS NOT NULL
        ORDER BY criado_em DESC LIMIT 20`, [tenantId])).rows;

    return { grupos, cota, mes, ultima, recusas, amostra };
  });
}

function conferirDisco(amostra) {
  let ok = 0;
  const faltando = [];
  for (const a of amostra) {
    if (fs.existsSync(a.caminho)) ok += 1;
    else faltando.push(a.caminho);
  }
  return { conferidos: amostra.length, ok, faltando };
}

function porSituacao(linhas) {
  const out = { pendente_curadoria: 0, cota_excedida: 0, falhou: 0 };
  for (const l of linhas) out[l.situacao] = l.n;
  return out;
}

/**
 * A unidade contratou o módulo? É a PRIMEIRA chave, e a que o painel esquecia: sem ela a
 * captura para no portão do contrato mesmo com grupo escolhido, e a tela dizia apenas
 * "nenhum grupo" — mandando a pessoa configurar o que não ia resolver.
 */
async function contratacao(tenantId) {
  try {
    await licenca.garantirModulo(tenantId, ingestao.MODULO);
    return { contratado: true, motivo: null };
  } catch (e) {
    return { contratado: false, motivo: e.motivo || e.message };
  }
}

function humano(u, p, disco, dias) {
  const s = porSituacao(p.mes);
  const limite = p.cota[ingestao.COTA_CHAVE];
  const ativos = p.grupos.filter((g) => g.ativo);

  console.log(`\n── ${u.name}  (${u.id})`);
  console.log(p.contrato.contratado
    ? '   módulo MARKETING: contratado'
    : `   módulo MARKETING: NÃO CONTRATADO (${p.contrato.motivo}) — a captura não roda, mesmo com grupo.`);
  if (!p.grupos.length) {
    console.log('   grupos-fonte: NENHUM — a ingestão está desligada para esta unidade.');
  } else {
    for (const g of p.grupos) {
      console.log(`   grupo-fonte: ${g.ativo ? 'ativo  ' : 'inativo'} ${g.nome || '(sem nome)'}  ${g.jid}`);
    }
  }
  const cotaTxt = limite == null ? 'sem limite' : `${s.pendente_curadoria}/${limite}`;
  console.log(`   mês: ${s.pendente_curadoria} aceitas (cota ${cotaTxt})  |  ${s.cota_excedida} por cota  |  ${s.falhou} falhas`);
  console.log(p.ultima
    ? `   última: ${new Date(p.ultima.criado_em).toISOString()}  ${p.ultima.tipo}  de ${p.ultima.remetente_nome || '?'}  [${p.ultima.situacao}]`
    : '   última: nunca entrou nada.');
  if (p.recusas.length) {
    console.log(`   recusas (${dias}d):`);
    for (const r of p.recusas) console.log(`     ${String(r.n).padStart(4)}  ${r.situacao}  ${r.motivo || '(sem motivo)'}`);
  }
  if (disco.conferidos) {
    console.log(`   disco: ${disco.ok}/${disco.conferidos} arquivos presentes`
      + (disco.faltando.length ? `  ⚠ FALTAM ${disco.faltando.length}` : ''));
    for (const f of disco.faltando.slice(0, 3)) console.log(`     falta: ${f}`);
  }
  // O diagnóstico que a pessoa de plantão realmente quer — e as DUAS chaves separadas,
  // porque são decisões de gente diferente (contratar é comercial; escolher o grupo é da
  // recepção) e mandar configurar a errada é fazer alguém trabalhar à toa.
  if (!p.contrato.contratado) {
    console.log('   → para ligar: contratar o módulo MARKETING' + (ativos.length ? '' : ' E escolher o grupo na tela') + '.');
  } else if (!ativos.length) {
    console.log('   → para ligar: escolher o grupo na tela de configuração da unidade.');
  } else if (!s.pendente_curadoria && !s.cota_excedida && !s.falhou) {
    // "Nada entrou" quer dizer coisas opostas conforme a idade da configuração: num grupo
    // ligado há semanas é defeito; num ligado hoje é só ninguém ter mandado foto ainda.
    // O alarme que não distingue os dois gasta o plantão e, pior, ensina a ignorá-lo.
    const horas = (Date.now() - new Date(ativos[0].criado_em)) / 3_600_000;
    console.log(horas < 48
      ? `   recém-ligado (há ${Math.max(1, Math.round(horas))}h) — aguardando a primeira foto ou vídeo no grupo.`
      : '   ⚠ tudo ligado e nada entrou este mês — conferir se o número está no grupo.');
  }
}

(async () => {
  const o = args();
  const lista = await unidades(o.tenant);
  if (!lista.length) { console.log('nenhuma unidade encontrada.'); await pool.end(); return; }

  for (const tenantId of lista) {
    const u = { id: tenantId, name: await nomeDaUnidade(tenantId) };
    let p;
    try {
      p = await panorama(tenantId, o.dias);
    } catch (e) {
      // 42P01 = migração 175 ainda não aplicada aqui. Dizer isso é mais útil que uma pilha.
      const msg = e.code === '42P01' ? 'tabelas da ingestão não existem (migração 175 não aplicada)' : e.message;
      if (o.json) console.log(JSON.stringify({ tenant_id: u.id, nome: u.name, erro: msg }));
      else console.log(`\n── ${u.name}  (${u.id})\n   erro: ${msg}`);
      continue;
    }
    p.contrato = await contratacao(tenantId);
    const disco = conferirDisco(p.amostra);
    if (o.json) {
      console.log(JSON.stringify({
        tenant_id: u.id, nome: u.name, contrato: p.contrato,
        capturando: p.contrato.contratado && p.grupos.some((g) => g.ativo),
        grupos: p.grupos, cota: p.cota, mes: porSituacao(p.mes),
        ultima: p.ultima, recusas: p.recusas, disco,
      }));
    } else {
      humano(u, p, disco, o.dias);
    }
  }
  if (!o.json) console.log('');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
