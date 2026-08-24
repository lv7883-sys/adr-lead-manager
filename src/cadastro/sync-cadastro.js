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
// rejeita data-zero ("0000-00-00" e variantes com componente 00) — passa na regex mas estoura
// no ::date. Zero em ano/mês/dia → null (contrato entra com vigência nula, não quebra o cron).
const _iso = (s) => {
  const v = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  return (y && m && d) ? v : null;
};

// nome-norm p/ casar o MESMO humano cadastrado 2x na Extranet (sem acento, minúsculo, só [a-z0-9 ]).
// Igual ao de dedup-person.js — mantido local p/ o sync não depender do script de manutenção.
function _normNome(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
const _ult8 = (s) => String(s || '').replace(/\D/g, '').slice(-8);

// ANTI-DUPLICATA (raiz do problema de person por-cadastro): antes de CRIAR uma person nova p/ um
// aluno_id inédito, procura um humano JÁ cadastrado (com OUTRO aluno_id) que seja o mesmo:
//   casa se nome-norm igual E ( mesma data_nascimento  OU  (nasc ausente num deles + telefone casa) ).
// NUNCA casa dois nascimentos DIFERENTES → homônimos reais ficam separados. Só considera persons que
// já são beneficiárias da Extranet (não funde papéis diferentes). Devolve o id existente ou null.
async function _findByIdentity(c, tid, match) {
  const nomeAlvo = _normNome(match && match.nome);
  if (!nomeAlvo) return null;
  const dob = _iso(match.dataNascimento);
  const tel = _ult8(match.telefone);
  if (!dob && !tel) return null;                       // sem âncora de identidade → não arrisca
  const { rows } = await c.query(
    `SELECT p.id, p.display_name, to_char(p.data_nascimento,'YYYY-MM-DD') AS dob,
            (SELECT array_agg(right(regexp_replace(cp.value_raw,'[^0-9]','','g'),8))
               FROM lead_manager.contact_point cp WHERE cp.person_id=p.id AND cp.kind='phone') AS fones
       FROM lead_manager.person p
      WHERE tenant_id=$1
        AND EXISTS (SELECT 1 FROM lead_manager.external_ref er
                     WHERE er.entity_kind='person' AND er.entity_id=p.id
                       AND er.source=$2 AND er.external_type='beneficiario')
        AND ( ($3::date IS NOT NULL AND p.data_nascimento=$3::date)
           OR ($4 <> '' AND EXISTS (SELECT 1 FROM lead_manager.contact_point cp
                 WHERE cp.person_id=p.id AND cp.kind='phone'
                   AND right(regexp_replace(cp.value_raw,'[^0-9]','','g'),8)=$4)) )`,
    [tid, CADASTRO_SOURCE, dob, tel]);
  for (const r of rows) {
    if (_normNome(r.display_name) !== nomeAlvo) continue;
    if (dob && r.dob && dob !== r.dob) continue;        // nascimentos divergem → homônimo, não casa
    const foneOk = tel && (r.fones || []).some((f) => f === tel);
    if ((dob && r.dob && dob === r.dob) || foneOk) return r.id;  // mesmo nasc OU (nasc-ausente + fone casa)
  }
  return null;
}

// Pessoa por external_ref; se não houver, tenta casar por IDENTIDADE (anti-duplicata); só então cria
// BARE (campos vêm pelo _syncPersonField). `match` (opcional, só p/ beneficiário) = {nome, dataNascimento,
// telefone}. Devolve {id, novo, reused}. reused=true → reaproveitou humano existente de outro aluno_id.
async function _person(c, tid, type, extId, match) {
  const ex = (await c.query(
    `SELECT entity_id FROM lead_manager.external_ref
      WHERE tenant_id=$1 AND entity_kind='person' AND source=$2 AND external_type=$3 AND external_id=$4`,
    [tid, CADASTRO_SOURCE, type, String(extId)])).rows[0];
  if (ex) return { id: ex.entity_id, novo: false };
  // anti-duplicata: reusa o humano já cadastrado (outro aluno_id) e só ADICIONA o external_ref novo.
  const existente = match ? await _findByIdentity(c, tid, match) : null;
  const pid = existente
    || (await c.query(`INSERT INTO lead_manager.person (tenant_id) VALUES ($1) RETURNING id`, [tid])).rows[0].id;
  await c.query(
    `INSERT INTO lead_manager.external_ref (tenant_id, entity_kind, entity_id, source, external_type, external_id)
     VALUES ($1,'person',$2,$3,$4,$5) ON CONFLICT (tenant_id, source, external_type, external_id) DO NOTHING`,
    [tid, pid, CADASTRO_SOURCE, type, String(extId)]);
  return { id: pid, novo: !existente, reused: !!existente };
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

// Telefone do cadastro → contact_point (kind=phone). Idempotente: só cria se ainda
// não houver, comparando pelos DÍGITOS normalizados (ignora máscara). Nunca sobrescreve
// nem apaga — a fonte de verdade continua sendo o cadastro, mas outros telefones
// (whatsapp/conversa) provados ficam intactos.
async function _contato(c, tid, personId, telefone) {
  const raw = String(telefone || '').trim();
  if (!raw || !/\d/.test(raw) || !personId) return false;
  const r = await c.query(
    `INSERT INTO lead_manager.contact_point (tenant_id, person_id, kind, value_raw, source, confidence, tipo)
     SELECT $1,$2,'phone',$3,'extranet','alegado','cadastro'
      WHERE NOT EXISTS (
        SELECT 1 FROM lead_manager.contact_point
         WHERE tenant_id=$1 AND person_id=$2 AND kind='phone'
           AND regexp_replace(value_raw,'[^0-9]','','g') = regexp_replace($3,'[^0-9]','','g'))
     RETURNING id`,
    [tid, personId, raw]);
  return r.rowCount > 0;
}

// Diff completo de um snapshot. Devolve stats. NÃO faz fetch (o adapter já produziu).
async function syncCadastro(c, { tenantId, snapshot }) {
  const st = { contratos_novos: 0, atualizados: 0, inalterados: 0, pessoas_novas: 0, pessoas_reusadas: 0, vinculos_novos: 0,
    person_escreveu: 0, person_divergencia: 0, soft_deleted: 0, reaparecidos: 0, contatos_novos: 0 };
  const presentes = new Set();

  for (const ct of snapshot.contratos) {
    presentes.add(String(ct.idC));
    // --- BENEFICIÁRIO (pessoa) --- anti-duplicata: casa o mesmo humano cadastrado 2x (aluno_id ≠) por
    // nome+nascimento OU nome+telefone antes de criar uma person nova (raiz do person por-cadastro).
    const pa = await _person(c, tenantId, 'beneficiario', ct.aluno.idExterno,
      { nome: ct.aluno.nome, dataNascimento: ct.aluno.dataNascimento, telefone: ct.aluno.telefone });
    if (pa.novo) st.pessoas_novas++;
    if (pa.reused) st.pessoas_reusadas++;
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
    // telefone de contato do aluno (WhatsApp) → contact_point, p/ o NPS alcançar
    if (ct.aluno.telefone && await _contato(c, tenantId, pa.id, ct.aluno.telefone)) st.contatos_novos++;
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
