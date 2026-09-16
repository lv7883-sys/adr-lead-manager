'use strict';
// boas-vindas-sweep.itest.js — ADR-050 (E17-02): rotina diária em PG DESCARTÁVEL (test/run-boas-vindas-itest.sh).
// Roda o job de verdade (SQL de contratos, config, etapas, agenda do Scheduler, upsert) como lead_manager_user.
// Cobre: simulação não grava; módulo desligado não roda; régua inválida não roda; matrícula nova gera
// mensagens com dia/horário/professor da agenda; renovação e contato interno ficam de fora; segunda
// rodada não muda nada; mensagem já enviada é intocável; aula remarcada atualiza o lembrete pendente;
// ativação não manda o atraso; unidade sem agenda só tem as etapas do início do contrato.
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const { pool, withTenant } = require('../src/db');
const sweep = require('../src/jobs/boas-vindas-sweep');

const A = process.env.BV_TENANT_C;   // tem franquia (agenda) no schema app
const B = process.env.BV_TENANT_D;   // sem franquia
const MODELO = 'escola-de-musica-academia-do-rock';
const sp = (data, hhmm) => Date.parse(`${data}T${hhmm}:00-03:00`);
const AGORA = sp('2026-09-21', '09:30');   // segunda-feira

const HORARIO = JSON.stringify({ 1: [{ inicio: '09:00', fim: '21:00' }], 2: [{ inicio: '09:00', fim: '21:00' }],
  3: [{ inicio: '09:00', fim: '21:00' }], 4: [{ inicio: '09:00', fim: '21:00' }], 5: [{ inicio: '09:00', fim: '21:00' }],
  6: [{ inicio: '09:00', fim: '13:00' }] });

async function pessoa(t, nome, fone, extAluno) {
  return withTenant(t, async (c) => {
    const id = (await c.query('INSERT INTO lead_manager.person (tenant_id, display_name) VALUES ($1,$2) RETURNING id', [t, nome])).rows[0].id;
    if (fone) {
      await c.query(`INSERT INTO lead_manager.contact_point (tenant_id, person_id, kind, value_raw, source, confidence, tipo)
                     VALUES ($1,$2,'phone',$3,'extranet','provado','cadastro')`, [t, id, fone]);
    }
    if (extAluno) {
      await c.query(`INSERT INTO lead_manager.external_ref (tenant_id, entity_kind, entity_id, source, external_type, external_id)
                     VALUES ($1,'person',$2,'extranet','beneficiario',$3)`, [t, id, extAluno]);
    }
    return id;
  });
}
async function contrato(t, { ini, fim = '2027-09-17', ext, aluno, pagador, periodicidade = 'anual' }) {
  return withTenant(t, async (c) => {
    const acc = (await c.query(`INSERT INTO lead_manager.service_account (tenant_id, status, servico_label, periodicidade, ini_vigencia, fim_vigencia, professor_nome)
                                VALUES ($1,'ativo','Baixo',$2,$3::date,$4::date,'Marcos Teixeira') RETURNING id`, [t, periodicidade, ini, fim])).rows[0].id;
    await c.query(`INSERT INTO lead_manager.external_ref (tenant_id, entity_kind, entity_id, source, external_type, external_id)
                   VALUES ($1,'account',$2,'extranet','contrato',$3)`, [t, acc, ext]);
    await c.query(`INSERT INTO lead_manager.account_member (tenant_id, account_id, person_id, bond) VALUES ($1,$2,$3,'beneficiario')`, [t, acc, aluno]);
    if (pagador) await c.query(`INSERT INTO lead_manager.account_member (tenant_id, account_id, person_id, bond) VALUES ($1,$2,$3,'pagador')`, [t, acc, pagador]);
    return acc;
  });
}
const aulaJson = (o) => ({ data: o.data, sala: 'Sala 1', _prof: o.prof || 'Juliano Prado', prof_tag: 'Juliano', aluno: 'Aluno Teste',
  curso: 'Curso BASS', status: o.status || '', aula_id: o.id, hora_inicio: o.hora || '15:00', hora_fim: o.fim || '16:00',
  aulaStatus: 'normal', experimental: false, _id_aluno: o.aluno, _id_contrato: o.contrato });
async function agenda(semana, aulas) {
  const porDia = {};
  for (const a of aulas) (porDia[a.data] = porDia[a.data] || []).push(aulaJson(a));
  // Escrita no schema app só no setup: o app (lead_manager_user) só tem SELECT lá. Usa o superusuário do harness.
  await admin(`INSERT INTO app.agenda_snapshot (franquia_id, semana, snapshot) VALUES (1, $1, $2::jsonb)
               ON CONFLICT (franquia_id, semana) DO UPDATE SET snapshot = EXCLUDED.snapshot`, [semana, JSON.stringify({ aulasPorDia: porDia })]);
}
let adminPool;
const admin = (sql, params) => adminPool.query(sql, params);
const toques = (t, acc) => withTenant(t, async (c) => (await c.query(
  `SELECT bt.*, e.ordem FROM lead_manager.boas_vindas_toque bt JOIN lead_manager.boas_vindas_etapa e ON e.id = bt.etapa_id
    WHERE bt.account_id = $1 ORDER BY e.ordem, bt.repeticao`, [acc])).rows);

let novo, renov, interno;
before(async () => {
  const { Pool } = require('pg');
  adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
  await admin(`UPDATE lead_manager.tenants SET horario_comercial = $1::jsonb WHERE id IN ($2, $3)`, [HORARIO, A, B]);
  await admin(`INSERT INTO app.franquia (id, slug, lead_tenant_id) VALUES (1, 'unidade-a', $1) ON CONFLICT DO NOTHING`, [A]);

  // Matrícula nova (sexta 18/09) com responsável; 1ª aula quinta 24/09 15h, 2ª em 01/10.
  const pedro = await pessoa(A, 'PEDRO SOUZA', null, '540');
  const carla = await pessoa(A, 'Carla Souza', '5519922220000');
  novo = await contrato(A, { ini: '2026-09-18', ext: '1154', aluno: pedro, pagador: carla });
  // Renovação: a mesma pessoa já tinha contrato.
  const ana = await pessoa(A, 'Ana Lima', '5519933330000', '600');
  await contrato(A, { ini: '2025-09-01', fim: '2026-08-31', ext: '900', aluno: ana });
  renov = await contrato(A, { ini: '2026-09-19', ext: '1160', aluno: ana });
  // Contato interno (professor da casa com contrato próprio).
  const prof = await pessoa(A, 'Rafael Professor', '5519944440000', '700');
  interno = await contrato(A, { ini: '2026-09-19', ext: '1170', aluno: prof });
  await admin(`INSERT INTO lead_manager.internal_contacts (tenant_id, phone, name, type) VALUES ($1,'19944440000','Rafael','professor')`, [A]);

  await agenda('2026-09-21', [
    { id: '1', data: '2026-09-24', aluno: 540, contrato: 1154 },
    { id: '2', data: '2026-09-25', aluno: 600, contrato: 1160 },
  ]);
  await agenda('2026-09-28', [{ id: '3', data: '2026-10-01', aluno: 540, contrato: 1154 }]);

  await withTenant(A, (c) => c.query(`INSERT INTO lead_manager.automacao_config (tenant_id) VALUES ($1)`, [A]));
  await withTenant(B, (c) => c.query(`INSERT INTO lead_manager.automacao_config (tenant_id) VALUES ($1)`, [B]));
});
after(async () => { await pool.end(); await adminPool.end(); });

test('simulação (--dry): roda com o módulo desligado e sem régua própria, e NÃO grava nada', async () => {
  const r = await sweep.processarTenant(A, { dry: true, agora: AGORA });
  assert.equal(r.origemRegua, `modelo:${MODELO}`);
  assert.equal(r.agenda, 'academia-do-rock');
  assert.ok(r.resumo.elegiveis >= 1);
  assert.equal((await toques(A, novo)).length, 0);
});

test('módulo desligado: a rotina não roda', async () => {
  assert.equal((await sweep.processarTenant(A, { agora: AGORA })).pulado, 'modo_desligado');
});

test('régua inválida (falta a variável {link_ead}): a rotina não roda e diz por quê', async () => {
  await withTenant(A, async (c) => {
    await c.query(`UPDATE lead_manager.automacao_config SET boas_vindas_modo = 'avisa' WHERE tenant_id = $1`, [A]);
    await c.query('SELECT lead_manager.boas_vindas_copiar_modelo($1, $2, $3)', [A, MODELO, 'itest']);
  });
  const r = await sweep.processarTenant(A, { agora: AGORA });
  assert.equal(r.pulado, 'regua_invalida');
  assert.ok(r.erros.some((e) => e.includes('{link_ead}')));
});

test('matrícula nova: grava as mensagens com a aula da agenda; renovação e contato interno ficam de fora', async () => {
  await withTenant(A, (c) => c.query(
    `UPDATE lead_manager.automacao_config SET boas_vindas_variaveis = '{"link_ead":"https://ead.exemplo.com"}' WHERE tenant_id = $1`, [A]));
  const r = await sweep.processarTenant(A, { agora: AGORA });
  assert.equal(r.pulado, undefined);
  assert.ok(r.gravacao.criado > 0);
  const ts = await toques(A, novo);
  const bv1 = ts.find((t) => t.ordem === 1);
  assert.equal(bv1.status, 'pendente');
  assert.equal(bv1.versao, 'responsavel');
  assert.equal(bv1.phone, '5519922220000');
  assert.match(bv1.texto_final, /\* Professor: Juliano\n\* Dia: quinta-feira, 24\/09\n\* Horário: 15h/);
  const lembrete1 = ts.find((t) => t.ordem === 3 && t.repeticao === 1);
  assert.equal(new Date(lembrete1.due_at).toISOString(), new Date(sp('2026-09-23', '18:00')).toISOString());
  assert.equal((await toques(A, renov)).length, 0, 'renovação');
  assert.equal((await toques(A, interno)).length, 0, 'contato interno');
});

test('segunda rodada no mesmo momento: nada muda', async () => {
  const r = await sweep.processarTenant(A, { agora: AGORA });
  assert.deepEqual(r.gravacao, { criado: 0, atualizado: 0, sem_mudanca: 0 });
});

test('enviada é intocável; aula remarcada atualiza o lembrete ainda pendente', async () => {
  await withTenant(A, (c) => c.query(
    `UPDATE lead_manager.boas_vindas_toque SET status = 'enviado', enviado_em = '2026-09-21T09:35:00-03:00'
      WHERE account_id = $1 AND etapa_id = (SELECT id FROM lead_manager.boas_vindas_etapa WHERE ordem = 1)`, [novo]));
  await agenda('2026-09-21', [
    { id: '1', data: '2026-09-25', hora: '10:00', fim: '11:00', aluno: 540, contrato: 1154, prof: 'Ana Costa' },   // remarcada: sexta 10h
    { id: '2', data: '2026-09-25', aluno: 600, contrato: 1160 },
  ]);
  const r = await sweep.processarTenant(A, { agora: AGORA });
  assert.ok(r.gravacao.atualizado >= 1);
  const ts = await toques(A, novo);
  const bv1 = ts.find((t) => t.ordem === 1);
  assert.equal(bv1.status, 'enviado');
  assert.match(bv1.texto_final, /quinta-feira, 24\/09/, 'o texto enviado não é reescrito');
  const lembrete1 = ts.find((t) => t.ordem === 3 && t.repeticao === 1);
  assert.equal(new Date(lembrete1.due_at).toISOString(), new Date(sp('2026-09-24', '18:00')).toISOString());
  assert.match(lembrete1.texto_final, /sexta-feira, 25\/09, às 10h, com o professor Ana/);
});

test('ativação: o que já venceu não vai para a recepção', async () => {
  const bia = await pessoa(A, 'Bia Rocha', '5519955550000', '800');
  const antigo = await contrato(A, { ini: '2026-09-01', ext: '1180', aluno: bia });
  const r = await sweep.processarTenant(A, { agora: AGORA, ativacao: true });
  assert.ok(r.resumo.foraDaJanela > 0);
  const ts = await toques(A, antigo);
  assert.ok(ts.length > 0);
  assert.ok(ts.every((t) => t.status !== 'pendente' || new Date(t.due_at).getTime() > AGORA), 'nada atrasado pendente');
  assert.ok(ts.some((t) => t.motivo === 'anterior_a_ativacao'));
});

test('unidade sem agenda integrada: a simulação aponta a régua inválida e o motivo', async () => {
  const r = await sweep.processarTenant(B, { dry: true, agora: AGORA });
  assert.equal(r.agenda, null);
  assert.equal(r.motivoSemAgenda, 'unidade_sem_franquia');
  assert.equal(r.reguaValida, false);
  assert.ok(r.errosRegua.some((e) => e.includes('agenda')));
});

test('runBoasVindasSweep: percorre as unidades ativas e isola erro de uma unidade', async () => {
  const r = await sweep.runBoasVindasSweep({ agora: AGORA, portao: async () => [A, B, '00000000-0000-4000-8000-000000000000'] });
  assert.equal(r.length, 3);
  assert.equal(r[1].pulado, 'modo_desligado');
  assert.ok(r[2].erro || r[2].pulado, 'unidade inexistente não derruba as outras');
});
