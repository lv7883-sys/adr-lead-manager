'use strict';
//
// dedup-person.js — HIGIENE CANÔNICA: funde person DUPLICADAS por-cadastro.
//
// PROBLEMA: lead_manager.person NÃO é canônico por-HUMANO, é por-CADASTRO-da-Extranet.
// _person() (sync-cadastro.js) casa SÓ por external_ref(aluno_id). Quando a Extranet
// cadastrou o MESMO humano com 2 aluno_id distintos, o sync criou uma person para cada.
// Resultado: contratos do mesmo aluno repartidos entre 2 person.id → evasão/renovação
// veem "duas pessoas". Impacto de headline é pequeno (<1pp), então isto é higiene, não urgência.
//
// CRITÉRIO (o mesmo do name-keying que já funde no dashboard, agora com trava de nascimento):
//   DUPLICATA  = mesmo nome-norm E mesma data_nascimento (ou nasc ausente num deles + telefone casa).
//   HOMÔNIMO   = mesmo nome-norm mas nascimentos DIFEREM → pessoas diferentes, NÃO tocar.
//                (ex.: Leonardo Vecchi, Isabella Conte Carvalho, Rafael Serrão Tarifa.)
//
// USO (sempre por docker exec no VPS, molde dos outros scripts de cadastro):
//   Diagnóstico (read-only, lista TODOS os grupos com >1 person):
//     docker exec adr-lead-manager node src/cadastro/dedup-person.js diagnose
//   Plano de fusão (DRY-RUN, não escreve nada — é o default):
//     docker exec adr-lead-manager node src/cadastro/dedup-person.js merge
//   Aplicar de verdade (transação POR GRUPO, idempotente):
//     docker exec adr-lead-manager node src/cadastro/dedup-person.js merge --apply
//   Restringir a um tenant:  ... --tenant=<uuid>
//
const { pool, withTenant } = require('../db');
const logger = require('../logger');

const CADASTRO_SOURCE = 'extranet';

// nome-norm p/ AGRUPAR (sem acento, minúsculo, só [a-z0-9 ], espaço único). Diferente do
// normNome de sync-professores: NÃO remove "prof" (aqui são alunos; "prof" pode ser parte do nome).
function normNome(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const ult8 = (s) => soDigitos(s).slice(-8);

// telefones de uma person já vêm como array de dígitos crus; reduz p/ conjunto de últimos-8
// (o casamento BR-aware — com/sem 55/9 — vive no lookup do LM; aqui últimos-8 basta p/ overlap).
const setUlt8 = (phones) => new Set((phones || []).map(ult8).filter((d) => d.length >= 8));
const temOverlap = (a, b) => { for (const d of a) if (b.has(d)) return true; return false; };

// completude de uma person p/ desempate na escolha do sobrevivente.
const completude = (p) => (p.dob ? 1 : 0) + (p.payer_relation ? 1 : 0) + (p.phones ? p.phones.length : 0)
  + (p.display_name && p.display_name.trim() ? 1 : 0);

// Sobrevivente = MAIS contratos → MAIS completo → MAIS antigo (created_at). Determinístico.
function escolherSobrevivente(persons) {
  return [...persons].sort((a, b) =>
    (b.contratos - a.contratos)
    || (completude(b) - completude(a))
    || (new Date(a.created_at) - new Date(b.created_at))
    || String(a.id).localeCompare(String(b.id)))[0];
}

// Classifica um grupo de persons com o MESMO nome-norm (>1). Devolve:
//   tipo: 'DUPLICATA' | 'HOMONIMO'
//   mergeable: persons que podem fundir (mesmo nasc, ou nasc-ausente com telefone que casa)
//   ambiguos:  persons nasc-ausente cujo telefone NÃO casa (não fundir sem revisão humana)
function classificarGrupo(persons) {
  const dobs = [...new Set(persons.map((p) => p.dob).filter(Boolean))];
  if (dobs.length >= 2) {
    // nascimentos distintos coexistem → homônimos reais. NÃO fundir nada do grupo.
    return { tipo: 'HOMONIMO', mergeable: [], ambiguos: [], motivo: `${dobs.length} nascimentos distintos` };
  }
  const dobComum = dobs[0] || null;             // 0 ou 1 nascimento no grupo todo
  const comDob = persons.filter((p) => p.dob);  // = os que têm o nasc comum
  const semDob = persons.filter((p) => !p.dob);
  // conjunto de telefones do "núcleo" (quem tem o nasc comum; se ninguém tem, todos entram no núcleo-fone)
  const nucleo = comDob.length ? comDob : semDob;
  const fonesNucleo = new Set();
  for (const p of nucleo) for (const d of setUlt8(p.phones)) fonesNucleo.add(d);

  const mergeable = [...comDob];
  const ambiguos = [];
  for (const p of semDob) {
    if (comDob.length === 0) { mergeable.push(p); continue; }         // grupo todo sem nasc → junta por nome+fone
    if (temOverlap(setUlt8(p.phones), fonesNucleo)) mergeable.push(p); // nasc-ausente mas telefone casa → é o mesmo
    else ambiguos.push(p);                                            // nasc-ausente e telefone não casa → revisar
  }
  return { tipo: 'DUPLICATA', mergeable, ambiguos, dobComum, motivo: dobComum ? `nasc ${dobComum}` : 'nasc ausente + telefone casa' };
}

// Lê TODAS as persons que são BENEFICIÁRIAS da Extranet (exclui person só-professor), com o que
// o diagnóstico/fusão precisam. tenant-scoped (roda dentro de withTenant).
async function fetchBeneficiarios(c) {
  const { rows } = await c.query(
    `SELECT p.id,
            p.display_name,
            to_char(p.data_nascimento,'YYYY-MM-DD') AS dob,
            p.payer_relation,
            p.created_at,
            (SELECT array_agg(DISTINCT er.external_id ORDER BY er.external_id)
               FROM lead_manager.external_ref er
              WHERE er.entity_kind='person' AND er.entity_id=p.id
                AND er.source=$1 AND er.external_type='beneficiario') AS aluno_ids,
            (SELECT array_agg(DISTINCT regexp_replace(cp.value_raw,'[^0-9]','','g'))
               FROM lead_manager.contact_point cp
              WHERE cp.person_id=p.id AND cp.kind='phone') AS phones,
            (SELECT count(*)::int FROM lead_manager.account_member am
              WHERE am.person_id=p.id AND am.bond='beneficiario') AS contratos
       FROM lead_manager.person p
      WHERE EXISTS (SELECT 1 FROM lead_manager.external_ref er
                     WHERE er.entity_kind='person' AND er.entity_id=p.id
                       AND er.source=$1 AND er.external_type='beneficiario')`,
    [CADASTRO_SOURCE]);
  return rows.map((r) => ({ ...r, aluno_ids: r.aluno_ids || [], phones: r.phones || [] }));
}

// Monta os grupos (nome-norm com >1 person) já classificados. Ordena p/ leitura estável.
function montarGrupos(persons) {
  const byNome = new Map();
  for (const p of persons) {
    const k = normNome(p.display_name);
    if (!k) continue;
    if (!byNome.has(k)) byNome.set(k, []);
    byNome.get(k).push(p);
  }
  const grupos = [];
  for (const [nomeNorm, membros] of byNome) {
    if (membros.length < 2) continue;
    const cls = classificarGrupo(membros);
    const survivor = cls.tipo === 'DUPLICATA' && cls.mergeable.length >= 2
      ? escolherSobrevivente(cls.mergeable) : null;
    const losers = survivor ? cls.mergeable.filter((p) => p.id !== survivor.id) : [];
    grupos.push({
      nomeNorm,
      nomeExibicao: membros[0].display_name,
      persons: membros,
      ...cls,
      survivor,
      losers,
    });
  }
  // DUPLICATA fundível primeiro, depois ambíguos, homônimos por último; alfabético dentro
  const rank = (g) => (g.tipo === 'DUPLICATA' && g.losers.length ? 0 : g.tipo === 'DUPLICATA' ? 1 : 2);
  return grupos.sort((a, b) => (rank(a) - rank(b)) || a.nomeExibicao.localeCompare(b.nomeExibicao));
}

// ----------------------------------------------------------------------------
// DIAGNÓSTICO (read-only)
// ----------------------------------------------------------------------------
function imprimirPerson(p, marca) {
  const fones = [...new Set((p.phones || []).map(ult8).filter(Boolean))].join(',') || '—';
  console.log(
    `    ${marca} ${p.id}  nasc=${p.dob || '——————————'}  tel*8=[${fones}]  ` +
    `aluno_id=[${p.aluno_ids.join(',') || '—'}]  contratos=${p.contratos}  payer=${p.payer_relation || '—'}`);
}

async function diagnoseTenant(tenantId) {
  const persons = await withTenant(tenantId, fetchBeneficiarios);
  const grupos = montarGrupos(persons);
  const resumo = { tenant: tenantId, persons: persons.length, grupos: grupos.length,
    duplicata: 0, homonimo: 0, ambiguos: 0, personsAFundir: 0 };
  if (!grupos.length) { console.log(`\n[${tenantId}] nenhum nome com >1 person beneficiária.`); return resumo; }
  console.log(`\n===== TENANT ${tenantId} — ${persons.length} persons beneficiárias, ${grupos.length} nomes com >1 =====`);
  for (const g of grupos) {
    if (g.tipo === 'DUPLICATA') resumo.duplicata++; else resumo.homonimo++;
    resumo.ambiguos += g.ambiguos.length;
    if (g.losers.length) resumo.personsAFundir += g.losers.length;
    const tag = g.tipo === 'HOMONIMO' ? 'HOMÔNIMO (manter separados)'
      : g.losers.length ? `DUPLICATA → fundir ${g.losers.length} em 1` : 'DUPLICATA (nada a fundir)';
    console.log(`\n  «${g.nomeExibicao}»  [${tag}]  (${g.motivo})`);
    for (const p of g.persons) {
      const marca = g.survivor && p.id === g.survivor.id ? 'S' : g.losers.some((l) => l.id === p.id) ? 'x'
        : g.ambiguos.some((a) => a.id === p.id) ? '?' : ' ';
      imprimirPerson(p, marca);
    }
    if (g.ambiguos.length) console.log(`    ⚠ ${g.ambiguos.length} person(s) '?' = nasc ausente e telefone não casa → revisar à mão.`);
  }
  console.log(`\n  Resumo ${tenantId}: DUPLICATA=${resumo.duplicata}  HOMÔNIMO=${resumo.homonimo}  ` +
    `persons-a-fundir=${resumo.personsAFundir}  ambíguos=${resumo.ambiguos}`);
  return resumo;
}

// ----------------------------------------------------------------------------
// FUSÃO — plano (dry-run) e aplicação (transação por grupo)
// ----------------------------------------------------------------------------
// Tabelas com FK/soft-ref para person.id que precisam ser repontadas para o sobrevivente:
//   account_member.person_id      (FK, UNIQUE tenant+account+person+bond)
//   contact_point.person_id       (FK, sem unique — dedup por dígitos depois)
//   contact_role_member.person_id (FK SET NULL, UNIQUE é por telefone — repoint livre)
//   renovacao_touchpoint.person_id(FK, UNIQUE não inclui person — repoint livre)
//   external_ref.entity_id        (polimórfico, sem FK; UNIQUE por external_id — aluno_ids diferem)
//   service_account.professor_person_id (soft-ref; alunos não são professores, mas por segurança)

// Conta quantas linhas SAIRIAM de cada tabela (dry-run, sem escrever).
async function planGroup(c, g) {
  const loserIds = g.losers.map((l) => l.id);
  const q = async (sql) => (await c.query(sql, [loserIds])).rows[0].n;
  return {
    account_member: await q(`SELECT count(*)::int n FROM lead_manager.account_member WHERE person_id = ANY($1)`),
    contact_point: await q(`SELECT count(*)::int n FROM lead_manager.contact_point WHERE person_id = ANY($1)`),
    contact_role_member: await q(`SELECT count(*)::int n FROM lead_manager.contact_role_member WHERE person_id = ANY($1)`),
    renovacao_touchpoint: await q(`SELECT count(*)::int n FROM lead_manager.renovacao_touchpoint WHERE person_id = ANY($1)`),
    external_ref: await q(`SELECT count(*)::int n FROM lead_manager.external_ref WHERE entity_kind='person' AND entity_id = ANY($1)`),
    professor_ref: await q(`SELECT count(*)::int n FROM lead_manager.service_account WHERE professor_person_id = ANY($1)`),
    persons_removidas: loserIds.length,
  };
}

// Aplica a fusão de UM grupo. Deve rodar dentro de withTenant (transação atômica do grupo).
async function applyGroup(c, g) {
  const survivor = g.survivor.id;
  const loserIds = g.losers.map((l) => l.id);
  const out = { survivor, losers: loserIds };

  // 1) account_member: repointa o que não colide; remove o que colidiria (mesmo account+bond já no sobrevivente).
  const am = await c.query(
    `UPDATE lead_manager.account_member m SET person_id=$1
      WHERE m.person_id = ANY($2)
        AND NOT EXISTS (SELECT 1 FROM lead_manager.account_member m2
                         WHERE m2.account_id=m.account_id AND m2.person_id=$1 AND m2.bond=m.bond)`,
    [survivor, loserIds]);
  const amDel = await c.query(`DELETE FROM lead_manager.account_member WHERE person_id = ANY($1)`, [loserIds]);
  out.account_member = { repointed: am.rowCount, deleted_dupes: amDel.rowCount };

  // 2) contact_point: repointa tudo; depois dedup por (kind, dígitos p/ telefone | valor p/ email).
  const cp = await c.query(`UPDATE lead_manager.contact_point SET person_id=$1 WHERE person_id = ANY($2)`, [survivor, loserIds]);
  const cpDel = await c.query(
    `DELETE FROM lead_manager.contact_point a
       USING lead_manager.contact_point b
      WHERE a.person_id=$1 AND b.person_id=$1 AND a.id > b.id AND a.kind=b.kind
        AND (CASE WHEN a.kind='phone' THEN regexp_replace(a.value_raw,'[^0-9]','','g') ELSE lower(a.value_raw) END)
          = (CASE WHEN b.kind='phone' THEN regexp_replace(b.value_raw,'[^0-9]','','g') ELSE lower(b.value_raw) END)`,
    [survivor]);
  out.contact_point = { repointed: cp.rowCount, deleted_dupes: cpDel.rowCount };

  // 3) contact_role_member: soft-link (unique por telefone) → repoint direto.
  const crm = await c.query(`UPDATE lead_manager.contact_role_member SET person_id=$1 WHERE person_id = ANY($2)`, [survivor, loserIds]);
  out.contact_role_member = crm.rowCount;

  // 4) renovacao_touchpoint: unique não inclui person → repoint direto.
  const rt = await c.query(`UPDATE lead_manager.renovacao_touchpoint SET person_id=$1 WHERE person_id = ANY($2)`, [survivor, loserIds]);
  out.renovacao_touchpoint = rt.rowCount;

  // 5) external_ref (person): repointa os aluno_id dos perdedores para o sobrevivente (aluno_ids diferem → sem colisão).
  //    Guarda contra colisão rara e remove o que sobrar duplicado.
  const er = await c.query(
    `UPDATE lead_manager.external_ref e SET entity_id=$1
      WHERE e.entity_kind='person' AND e.entity_id = ANY($2)
        AND NOT EXISTS (SELECT 1 FROM lead_manager.external_ref e2
                         WHERE e2.tenant_id=e.tenant_id AND e2.source=e.source
                           AND e2.external_type=e.external_type AND e2.external_id=e.external_id
                           AND e2.entity_id=$1 AND e2.entity_kind='person')`,
    [survivor, loserIds]);
  const erDel = await c.query(
    `DELETE FROM lead_manager.external_ref WHERE entity_kind='person' AND entity_id = ANY($1)`, [loserIds]);
  out.external_ref = { repointed: er.rowCount, deleted_dupes: erDel.rowCount };

  // 6) service_account.professor_person_id (segurança — normalmente 0 p/ alunos).
  const pf = await c.query(`UPDATE lead_manager.service_account SET professor_person_id=$1 WHERE professor_person_id = ANY($2)`, [survivor, loserIds]);
  out.professor_ref = pf.rowCount;

  // 7) completa o sobrevivente com o melhor dado dos perdedores (só onde estiver vazio).
  const bestDob = g.dobComum || g.mergeable.map((p) => p.dob).find(Boolean) || null;
  const bestPayer = [g.survivor, ...g.losers].map((p) => p.payer_relation).find(Boolean) || null;
  const bestName = [g.survivor, ...g.losers].map((p) => (p.display_name || '').trim()).find(Boolean) || null;
  await c.query(
    `UPDATE lead_manager.person
        SET data_nascimento = COALESCE(data_nascimento, $2::date),
            payer_relation  = COALESCE(payer_relation, $3),
            display_name    = COALESCE(NULLIF(display_name,''), $4),
            updated_at = now()
      WHERE id=$1`,
    [survivor, bestDob, bestPayer, bestName]);

  // 8) remove as persons perdedoras (já sem filhos apontando p/ elas).
  const del = await c.query(`DELETE FROM lead_manager.person WHERE id = ANY($1)`, [loserIds]);
  out.persons_removidas = del.rowCount;
  return out;
}

async function mergeTenant(tenantId, { apply }) {
  const persons = await withTenant(tenantId, fetchBeneficiarios);
  const grupos = montarGrupos(persons).filter((g) => g.tipo === 'DUPLICATA' && g.losers.length);
  const resumo = { tenant: tenantId, grupos: grupos.length, fundidos: 0, erros: 0, personsRemovidas: 0 };
  if (!grupos.length) { console.log(`\n[${tenantId}] nada a fundir.`); return resumo; }
  console.log(`\n===== ${apply ? 'APLICANDO' : 'DRY-RUN'} — TENANT ${tenantId} — ${grupos.length} grupo(s) DUPLICATA a fundir =====`);
  for (const g of grupos) {
    const alvo = `«${g.nomeExibicao}» sobrevivente=${g.survivor.id} (${g.survivor.contratos}c) ← perde ${g.losers.map((l) => l.id).join(', ')}`;
    try {
      if (!apply) {
        const plano = await withTenant(tenantId, (c) => planGroup(c, g));
        console.log(`  [plan] ${alvo}\n         ${JSON.stringify(plano)}`);
      } else {
        const r = await withTenant(tenantId, (c) => applyGroup(c, g));   // transação atômica do grupo
        resumo.fundidos++; resumo.personsRemovidas += r.persons_removidas;
        logger.info('dedup_person.grupo_fundido', { tenant_id: tenantId, nome: g.nomeExibicao, ...r });
        console.log(`  [ok]   ${alvo}\n         ${JSON.stringify(r)}`);
      }
    } catch (e) {
      resumo.erros++;
      logger.error('dedup_person.grupo_erro', { tenant_id: tenantId, nome: g.nomeExibicao, error: e.message });
      console.log(`  [ERRO] ${alvo}\n         ${e.message}`);
    }
  }
  return resumo;
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
async function listarTenants(only) {
  if (only) return [only];
  const { rows } = await pool.query('SELECT tenant_id FROM tenants_active()');
  return rows.map((r) => r.tenant_id);
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'diagnose';
  const apply = args.includes('--apply');
  const only = (args.find((a) => a.startsWith('--tenant=')) || '').split('=')[1] || null;
  const tenants = await listarTenants(only);

  if (mode === 'diagnose') {
    const all = [];
    for (const t of tenants) all.push(await diagnoseTenant(t));
    const tot = all.reduce((s, r) => ({
      duplicata: s.duplicata + r.duplicata, homonimo: s.homonimo + r.homonimo,
      personsAFundir: s.personsAFundir + r.personsAFundir, ambiguos: s.ambiguos + r.ambiguos,
    }), { duplicata: 0, homonimo: 0, personsAFundir: 0, ambiguos: 0 });
    console.log(`\n##### TOTAL: DUPLICATA=${tot.duplicata}  HOMÔNIMO=${tot.homonimo}  persons-a-fundir=${tot.personsAFundir}  ambíguos=${tot.ambiguos} #####`);
    return tot;
  }
  if (mode === 'merge') {
    if (!apply) console.log('\n*** DRY-RUN (nada é escrito). Use --apply após revisar os grupos. ***');
    const all = [];
    for (const t of tenants) all.push(await mergeTenant(t, { apply }));
    const tot = all.reduce((s, r) => ({ grupos: s.grupos + r.grupos, fundidos: s.fundidos + r.fundidos,
      erros: s.erros + r.erros, personsRemovidas: s.personsRemovidas + r.personsRemovidas }),
      { grupos: 0, fundidos: 0, erros: 0, personsRemovidas: 0 });
    console.log(`\n##### ${apply ? 'APLICADO' : 'DRY-RUN'}: grupos=${tot.grupos}  fundidos=${tot.fundidos}  persons-removidas=${tot.personsRemovidas}  erros=${tot.erros} #####`);
    return tot;
  }
  throw new Error(`modo desconhecido: ${mode} (use diagnose | merge [--apply] [--tenant=<uuid>])`);
}

module.exports = {
  normNome, soDigitos, ult8, completude, escolherSobrevivente, classificarGrupo,
  montarGrupos, fetchBeneficiarios, planGroup, applyGroup, diagnoseTenant, mergeTenant,
};

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { logger.error('dedup_person.fatal', { error: e.message }); console.error(e); process.exit(1); });
}
