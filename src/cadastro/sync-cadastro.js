'use strict';
//
// sync-cadastro.js — DIFF diário de contratos/alunos (molde resources/sync.js). AGNÓSTICO DE
// FONTE: recebe um snapshot já parseado pelo adapter. Escreve o cadastro canônico.
//
// INVARIANTE DE PROVENIÊNCIA (ADR-037 emenda):
//   - Campo de PESSOA (display_name/data_nascimento/payer_relation) → aplicar_scraping ANTES de
//     escrever (070): não sobrescreve edição humana; divergência vira alerta. Só escreve no 'ESCREVE'.
//   - CONTRATO (service_account: status/servico/plano/periodicidade/vigência) → ESPELHO da fonte,
//     escrito DIRETO (ninguém edita à mão). Fora da proveniência.
//
// DIFF: novo → insere; mudou → atualiza (só se mudou de fato); sumiu → NÃO apaga, marca
// fonte_ausente_em (soft-delete) e conta. Reaparecer → volta a NULL.
//
const CADASTRO_SOURCE = 'extranet';
const PERIODICIDADES = new Set(['mensal', 'trimestral', 'semestral', 'anual', 'outro']);
const _iso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null);

// Pessoa por external_ref; cria BARE se não existir (campos vêm pelo _syncPersonField). {id, novo}.
async function _person(c, tid, type, extId) {
  const ex = (await c.query(
    `SELECT entity_id FROM lead_manager.external_ref
      WHERE tenant_id=$1 AND entity_kind='person' AND source=$2 AND external_type=$3 AND external_id=$4`,
    [tid, CADASTRO_SOURCE, type, String(extId)])).rows[0];
  if (ex) return { id: ex.entity_id, novo: false };
  const pid = (await c.query(`INSERT INTO lead_manager.person (tenant_id) VALUES ($1) RETURNING id`, [tid])).rows[0].id;
  await c.query(
    `INSERT INTO lead_manager.external_ref (tenant_id, entity_kind, entity_id, source, external_type, external_id)
     VALUES ($1,'person',$2,$3,$4,$5) ON CONFLICT (tenant_id, source, external_type, external_id) DO NOTHING`,
    [tid, pid, CADASTRO_SOURCE, type, String(extId)]);
  return { id: pid, novo: true };
}

// PROVENIÊNCIA: escreve um campo de pessoa SÓ se aplicar_scraping devolver 'ESCREVE'. Devolve
// o veredito ('ESCREVE'|'IGUAL'|'DIVERGE'|'novo'). O alerta de divergência é criado pela função.
async function _syncPersonField(c, tid, personId, novo, field, value, coltype) {
  if (value == null || value === '') return 'skip';
  const txt = String(value);
  if (novo) {                                   // pessoa nova → sem edição humana p/ proteger: escreve + já trava? Não:
    // escreve direto (não há trava), sem alerta. (marcar_edicao_humana é só p/ humano.)
    await c.query(`UPDATE lead_manager.person SET ${field}=$2${coltype || ''}, updated_at=now() WHERE id=$1`, [personId, value]);
    return 'novo';
  }
  const v = (await c.query(`SELECT lead_manager.aplicar_scraping('person',$1,$2,$3,$4) AS v`,
    [personId, field, txt, CADASTRO_SOURCE])).rows[0].v;
  if (v === 'ESCREVE') {
    await c.query(`UPDATE lead_manager.person SET ${field}=$2${coltype || ''}, updated_at=now() WHERE id=$1`, [personId, value]);
  }
  return v;   // 'IGUAL'/'DIVERGE' → NÃO escreve (DIVERGE gerou alerta)
}

// CONTRATO (espelho) — upsert direto por external_ref(account,'contrato',id). Detecta mudança
// p/ não churnar. Marca last_synced_at + fonte_ausente_em=NULL (presente). {id, novo, changed}.
async function _upsertContrato(c, tid, ct) {
  const extId = String(ct.idC);
  const per = PERIODICIDADES.has(ct.periodicidade) ? ct.periodicidade : null;
  const ini = _iso(ct.ini); const fim = _iso(ct.fim);
  const ex = (await c.query(
    `SELECT sa.id, sa.status, sa.servico_label, sa.plano_label, sa.periodicidade, sa.ini_vigencia, sa.fim_vigencia, sa.fonte_ausente_em
       FROM lead_manager.external_ref er JOIN lead_manager.service_account sa ON sa.id=er.entity_id
      WHERE er.tenant_id=$1 AND er.entity_kind='account' AND er.external_type='contrato' AND er.external_id=$2`,
    [tid, extId])).rows[0];
  if (ex) {
    const changed = ex.status !== (ct.status || null) || ex.servico_label !== (ct.curso || null)
      || ex.plano_label !== (ct.planoLabel || null) || ex.periodicidade !== per
      || _iso(ex.ini_vigencia && ex.ini_vigencia.toISOString ? ex.ini_vigencia.toISOString().slice(0, 10) : String(ex.ini_vigencia).slice(0, 10)) !== ini
      || _iso(ex.fim_vigencia && ex.fim_vigencia.toISOString ? ex.fim_vigencia.toISOString().slice(0, 10) : String(ex.fim_vigencia).slice(0, 10)) !== fim
      || ex.fonte_ausente_em != null;   // reapareceu
    const reappeared = ex.fonte_ausente_em != null;
    if (changed) {
      await c.query(
        `UPDATE lead_manager.service_account
            SET status=$2, servico_label=$3, plano_label=$4, periodicidade=$5, ini_vigencia=$6::date, fim_vigencia=$7::date,
                fonte_ausente_em=NULL, last_synced_at=now(), updated_at=now()
          WHERE id=$1`,
        [ex.id, ct.status || null, ct.curso || null, ct.planoLabel || null, per, ini, fim]);
    } else {
      await c.query(`UPDATE lead_manager.service_account SET last_synced_at=now() WHERE id=$1`, [ex.id]);
    }
    return { id: ex.id, novo: false, changed, reappeared };
  }
  const aid = (await c.query(
    `INSERT INTO lead_manager.service_account (tenant_id, status, servico_label, plano_label, periodicidade, ini_vigencia, fim_vigencia, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7::date, now()) RETURNING id`,
    [tid, ct.status || null, ct.curso || null, ct.planoLabel || null, per, ini, fim])).rows[0].id;
  await c.query(
    `INSERT INTO lead_manager.external_ref (tenant_id, entity_kind, entity_id, source, external_type, external_id)
     VALUES ($1,'account',$2,$3,'contrato',$4) ON CONFLICT (tenant_id, source, external_type, external_id) DO NOTHING`,
    [tid, aid, CADASTRO_SOURCE, extId]);
  return { id: aid, novo: true, changed: true };
}

async function _link(c, tid, accountId, personId, bond) {
  const r = await c.query(
    `INSERT INTO lead_manager.account_member (tenant_id, account_id, person_id, bond)
     VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, account_id, person_id, bond) DO NOTHING RETURNING id`,
    [tid, accountId, personId, bond]);
  return r.rowCount > 0;
}

// Diff completo de um snapshot. Devolve stats. NÃO faz fetch (o adapter já produziu).
async function syncCadastro(c, { tenantId, snapshot }) {
  const st = { contratos_novos: 0, atualizados: 0, inalterados: 0, pessoas_novas: 0, vinculos_novos: 0,
    person_escreveu: 0, person_divergencia: 0, soft_deleted: 0, reaparecidos: 0 };
  const presentes = new Set();

  for (const ct of snapshot.contratos) {
    presentes.add(String(ct.idC));
    // --- BENEFICIÁRIO (pessoa) ---
    const pa = await _person(c, tenantId, 'beneficiario', ct.aluno.idExterno);
    if (pa.novo) st.pessoas_novas++;
    for (const [f, v, tp] of [['display_name', ct.aluno.nome, ''], ['data_nascimento', ct.aluno.dataNascimento, '::date'], ['payer_relation', ct.aluno.payerRelation, '']]) {
      const verd = await _syncPersonField(c, tenantId, pa.id, pa.novo, f, v, tp);
      if (verd === 'ESCREVE' || verd === 'novo') st.person_escreveu++;
      else if (verd === 'DIVERGE') st.person_divergencia++;
    }
    // --- CONTRATO (espelho, direto) ---
    const acc = await _upsertContrato(c, tenantId, ct);
    if (acc.novo) st.contratos_novos++; else if (acc.changed) st.atualizados++; else st.inalterados++;
    if (acc.reappeared) st.reaparecidos++;
    if (await _link(c, tenantId, acc.id, pa.id, 'beneficiario')) st.vinculos_novos++;
    // --- TITULAR ---
    if (ct.responsavel && ct.responsavel.idExterno) {
      const pr = await _person(c, tenantId, 'responsavel_financeiro', ct.responsavel.idExterno);
      if (pr.novo) st.pessoas_novas++;
      if (await _link(c, tenantId, acc.id, pr.id, 'pagador')) st.vinculos_novos++;
    } else if (ct.aluno.payerRelation === 'self_paid') {
      if (await _link(c, tenantId, acc.id, pa.id, 'pagador')) st.vinculos_novos++;
    }
  }

  // --- SOFT-DELETE: contratos no banco (deste tenant/source) ausentes do snapshot → marca ---
  const doBanco = (await c.query(
    `SELECT sa.id, er.external_id, sa.fonte_ausente_em
       FROM lead_manager.external_ref er JOIN lead_manager.service_account sa ON sa.id=er.entity_id
      WHERE er.tenant_id=$1 AND er.entity_kind='account' AND er.external_type='contrato' AND er.source=$2`,
    [tenantId, CADASTRO_SOURCE])).rows;
  for (const row of doBanco) {
    if (!presentes.has(String(row.external_id)) && row.fonte_ausente_em == null) {
      await c.query(`UPDATE lead_manager.service_account SET fonte_ausente_em=now(), updated_at=now() WHERE id=$1`, [row.id]);
      st.soft_deleted++;
    }
  }
  return st;
}

module.exports = { syncCadastro };
