'use strict';
// dedup-person.itest.js — prova ISOLADA (PG descartável) de dois comportamentos:
//   (1) FUSÃO: mergeTenant repointa account_member/contact_point/external_ref/etc. p/ o sobrevivente,
//       apaga os perdedores e NÃO toca homônimos (nascimentos diferentes).
//   (2) PREVENÇÃO: syncCadastro reusa o humano já cadastrado quando chega OUTRO aluno_id com o mesmo
//       nome+nascimento (ou nome+telefone) — e mantém homônimos separados. NUNCA toca produção.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, withTenant } = require('../src/db');
const { syncCadastro } = require('../src/cadastro/sync-cadastro');
const { mergeTenant } = require('../src/cadastro/dedup-person');

const A = process.env.RESOURCES_TENANT_A;
const B = process.env.RESOURCES_TENANT_B;

// --- fixtures diretas: cria o estado LEGADO (duas persons p/ o mesmo humano), como PROD tem hoje.
async function seedLegacy(t, { nome, dob, alunoId, contratoId, phone, semContrato }) {
  return withTenant(t, async (c) => {
    const pid = (await c.query(
      `INSERT INTO lead_manager.person (tenant_id, display_name, data_nascimento, payer_relation)
       VALUES ($1,$2,$3::date,'self_paid') RETURNING id`, [t, nome, dob])).rows[0].id;
    await c.query(
      `INSERT INTO lead_manager.external_ref (tenant_id, entity_kind, entity_id, source, external_type, external_id)
       VALUES ($1,'person',$2,'extranet','beneficiario',$3)`, [t, pid, String(alunoId)]);
    if (phone) await c.query(
      `INSERT INTO lead_manager.contact_point (tenant_id, person_id, kind, value_raw, source, confidence, tipo)
       VALUES ($1,$2,'phone',$3,'extranet','alegado','cadastro')`, [t, pid, phone]);
    if (!semContrato) {
      const aid = (await c.query(
        `INSERT INTO lead_manager.service_account (tenant_id, status, servico_label) VALUES ($1,'Ativo','Violão') RETURNING id`, [t])).rows[0].id;
      await c.query(
        `INSERT INTO lead_manager.external_ref (tenant_id, entity_kind, entity_id, source, external_type, external_id)
         VALUES ($1,'account',$2,'extranet','contrato',$3)`, [t, aid, String(contratoId)]);
      await c.query(
        `INSERT INTO lead_manager.account_member (tenant_id, account_id, person_id, bond) VALUES ($1,$2,$3,'beneficiario')`, [t, aid, pid]);
    }
    return pid;
  });
}

// leituras (tenant-scoped)
const personsPorNome = (t, nomeLike) => withTenant(t, async (c) => (await c.query(
  `SELECT id, display_name, to_char(data_nascimento,'YYYY-MM-DD') dob FROM lead_manager.person
    WHERE lower(display_name) LIKE $1 ORDER BY display_name`, [nomeLike])).rows);
const alunoIdsDe = (t, pid) => withTenant(t, async (c) => (await c.query(
  `SELECT external_id FROM lead_manager.external_ref
    WHERE entity_kind='person' AND entity_id=$1 AND external_type='beneficiario' ORDER BY external_id`, [pid])).rows.map((r) => r.external_id));
const contratosDe = (t, pid) => withTenant(t, async (c) => (await c.query(
  `SELECT count(*)::int n FROM lead_manager.account_member WHERE person_id=$1 AND bond='beneficiario'`, [pid])).rows[0].n);
const personExiste = (t, pid) => withTenant(t, async (c) => (await c.query(
  `SELECT 1 FROM lead_manager.person WHERE id=$1`, [pid])).rowCount > 0);

const ct = (idC, idA, aluno) => ({
  idC, idA, curso: 'Violão', status: 'Ativo', ini: '2026-01-01', fim: '2026-12-31',
  planoLabel: 'Anual', periodicidade: 'anual',
  aluno: { idExterno: idA, payerRelation: 'self_paid', ...aluno }, responsavel: null });
const sync = (t, contratos) => withTenant(t, (c) => syncCadastro(c, { tenantId: t, snapshot: { contratos } }));

before(async () => {}); after(async () => { await pool.end(); });

// ===========================================================================
// (1) FUSÃO
// ===========================================================================
test('merge: funde 2 person do mesmo humano (mesmo nasc) e preserva ambos os contratos', async () => {
  const p1 = await seedLegacy(A, { nome: 'Melanie Krebs', dob: '2011-02-02', alunoId: 100, contratoId: 'C100', phone: '5519911110000' });
  const p2 = await seedLegacy(A, { nome: 'melanie  krebs', dob: '2011-02-02', alunoId: 200, contratoId: 'C200', phone: '5519911110000' });
  // órfão só-telefone (3º record do grupo, sem contrato) — deve fundir pelo telefone
  const p3 = await seedLegacy(A, { nome: 'Melanie Krebs', dob: null, alunoId: 300, phone: '5519911110000', semContrato: true, contratoId: null });

  // dry-run NÃO escreve
  await mergeTenant(A, { apply: false });
  assert.equal((await personsPorNome(A, 'melanie%')).length, 3, 'dry-run não pode apagar nada');

  await mergeTenant(A, { apply: true });
  const restantes = await personsPorNome(A, 'melanie%');
  assert.equal(restantes.length, 1, 'sobra 1 person canônica');
  const sobra = restantes[0];
  // sobrevivente = quem tinha mais contratos (empate 1×1 entre p1/p2 → completude/created_at); os 3 aluno_id consolidam
  assert.deepEqual(await alunoIdsDe(A, sobra.id), ['100', '200', '300']);
  assert.equal(await contratosDe(A, sobra.id), 2, 'os 2 contratos apontam p/ o sobrevivente');
  assert.equal(sobra.dob, '2011-02-02', 'nascimento preservado');
  // perdedores apagados
  const vivos = await Promise.all([p1, p2, p3].map((id) => personExiste(A, id)));
  assert.equal(vivos.filter(Boolean).length, 1);
});

test('merge: homônimos (nascimentos diferentes) NÃO são fundidos', async () => {
  const h1 = await seedLegacy(A, { nome: 'Rafael Serrao Tarifa', dob: '2010-01-01', alunoId: 401, contratoId: 'C401' });
  const h2 = await seedLegacy(A, { nome: 'rafael serrao tarifa', dob: '1990-06-06', alunoId: 402, contratoId: 'C402' });
  await mergeTenant(A, { apply: true });
  assert.equal((await personsPorNome(A, 'rafael%')).length, 2, 'homônimos permanecem separados');
  assert.ok(await personExiste(A, h1)); assert.ok(await personExiste(A, h2));
});

test('merge: idempotente — rodar de novo não muda nada', async () => {
  const antes = (await personsPorNome(A, 'melanie%')).length + (await personsPorNome(A, 'rafael%')).length;
  await mergeTenant(A, { apply: true });
  const depois = (await personsPorNome(A, 'melanie%')).length + (await personsPorNome(A, 'rafael%')).length;
  assert.equal(depois, antes);
});

// ===========================================================================
// (2) PREVENÇÃO (no próprio sync)
// ===========================================================================
test('prevenção: 2º aluno_id com mesmo nome+nascimento REUSA a person (não cria nova)', async () => {
  const s1 = await sync(B, [ct('E1', 'A1', { nome: 'Enzo Fernandes Vecchi', dataNascimento: '2012-03-03', telefone: '5519999990000' })]);
  assert.equal(s1.pessoas_novas, 1); assert.equal(s1.pessoas_reusadas, 0);
  const s2 = await sync(B, [ct('E2', 'A2', { nome: 'Enzo Fernandes Vecchi', dataNascimento: '2012-03-03', telefone: '5519999990000' })]);
  assert.equal(s2.pessoas_novas, 0); assert.equal(s2.pessoas_reusadas, 1, 'reusou o humano existente');
  const persons = await personsPorNome(B, 'enzo fernandes vecchi');
  assert.equal(persons.length, 1, 'só 1 person p/ o mesmo humano');
  assert.deepEqual(await alunoIdsDe(B, persons[0].id), ['A1', 'A2'], 'os 2 aluno_id na mesma person');
  assert.equal(await contratosDe(B, persons[0].id), 2);
});

test('prevenção: homônimo (nascimento diferente, MESMO telefone de família) cria person separada', async () => {
  const s3 = await sync(B, [ct('E3', 'A3', { nome: 'Enzo Fernandes Vecchi', dataNascimento: '1988-01-01', telefone: '5519999990000' })]);
  assert.equal(s3.pessoas_novas, 1, 'nascimento diverge → NOVA person, apesar do telefone igual');
  assert.equal(s3.pessoas_reusadas, 0);
  assert.equal((await personsPorNome(B, 'enzo fernandes vecchi')).length, 2);
});

test('prevenção: sem nascimento, casa por nome+telefone (fallback do órfão)', async () => {
  await sync(B, [ct('M1', 'A10', { nome: 'Maria Sem Nasc', dataNascimento: '2000-05-05', telefone: '5519888887777' })]);
  const s = await sync(B, [ct('M2', 'A11', { nome: 'Maria Sem Nasc', telefone: '19888887777' })]);  // sem nasc, últimos-8 batem
  assert.equal(s.pessoas_reusadas, 1, 'reusou por nome+telefone quando faltou o nascimento');
  const persons = await personsPorNome(B, 'maria sem nasc');
  assert.equal(persons.length, 1);
  assert.deepEqual(await alunoIdsDe(B, persons[0].id), ['A10', 'A11']);
});
