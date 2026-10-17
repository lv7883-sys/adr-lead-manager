'use strict';
//
// dados.js — ADR-050 (E17-02). Leituras e gravações da régua de boas-vindas no schema lead_manager.
// Todas as consultas recebem o cliente de um withTenant E filtram tenant_id = $1 explicitamente
// (defesa em profundidade: funcionam iguais com RLS e numa leitura administrativa só-leitura).
// As strings SQL são exportadas para a simulação reusar exatamente a mesma consulta.
//
const MODELO_PADRAO = 'escola-de-musica-academia-do-rock';

// Primeiro marco da régua de renovação (src/jobs/renovacao-sweep.js, MARCO_DE: 45 → 'D-45').
// O teto R2 do boas-vindas termina na véspera dele. Teste de paridade em boas-vindas-sweep.test.js.
const RENOVACAO_PRIMEIRO_MARCO_DIAS = 45;

// QUEM É RENOVAÇÃO (regra do dono, 16/10/2026): "a regra que temos para considerar uma renovação é
// de 2 meses". Ou seja: parou e voltou em até 60 dias = renovação (segue na régua de renovação, não
// recebe boas-vindas); ficou mais tempo parado = para a escola é cliente novo e recebe boas-vindas
// de novo, porque precisa do processo inteiro outra vez.
//
// Antes disso bastava EXISTIR qualquer contrato anterior, de qualquer época: em 30 dias de Valinhos,
// 31 dos 36 contratos novos caíam nessa rede, e 10 deles eram gente que tinha ficado de 1 a 3 meses
// fora. Contrato CANCELADO (ou sumido da fonte) também contava — uma contratação que não aconteceu
// fazia a pessoa deixar de ser aluno novo.
const RENOVACAO_GAP_DIAS = 60;

// Contratos que ainda podem gerar boas-vindas: a MATRÍCULA (contratação fechada) caiu nos últimos
// `janela` dias, e não estão cancelados. Traz titular e pagador com telefone, ids externos (ponte com
// a agenda), se o titular já tinha contrato antes (renovação não recebe boas-vindas) e se algum
// telefone é de contato interno.
//
// MATRÍCULA ≠ INÍCIO DAS AULAS (16/10/2026): a família fecha a contratação num dia e as aulas começam
// dias depois — 60% dos contratos de Valinhos, em média 4 dias. A janela olhava `ini_vigencia`, então
// o aluno recém-matriculado só aparecia para a recepção no primeiro dia de aula, com a mensagem de
// boas-vindas já atrasada. Agora a janela e a âncora usam `data_matricula` (migr 185, preenchida pelo
// enriquecimento), com reserva em `ini_vigencia` para o contrato antigo que ainda não tem a data.
const SQL_CONTRATOS = `
WITH alvo AS (
  SELECT sa.id AS account_id,
         to_char(sa.ini_vigencia, 'YYYY-MM-DD') AS ini_vigencia,
         to_char(sa.data_matricula, 'YYYY-MM-DD') AS data_matricula,
         to_char(sa.fim_vigencia, 'YYYY-MM-DD') AS fim_vigencia,
         sa.servico_label, sa.periodicidade, sa.professor_nome,
         (SELECT er.external_id FROM lead_manager.external_ref er
           WHERE er.tenant_id = $1 AND er.entity_kind = 'account' AND er.external_type = 'contrato'
             AND er.entity_id = sa.id ORDER BY er.external_id LIMIT 1) AS contrato_ext
    FROM lead_manager.service_account sa
   WHERE sa.tenant_id = $1
     AND sa.fonte_ausente_em IS NULL
     AND (sa.status IS NULL OR sa.status NOT IN ('Cancelado', 'Inativo', 'Não Renovado'))
     AND sa.ini_vigencia IS NOT NULL
     AND coalesce(sa.data_matricula, sa.ini_vigencia) BETWEEN ($2::date - $3::int) AND $2::date
),
membros AS (
  SELECT am.account_id, am.bond, am.person_id, p.display_name AS nome,
         (SELECT cp.value_raw FROM lead_manager.contact_point cp
           WHERE cp.tenant_id = $1 AND cp.person_id = am.person_id AND cp.kind = 'phone'
           ORDER BY (cp.confidence = 'provado') DESC, cp.created_at LIMIT 1) AS telefone,
         (SELECT er.external_id FROM lead_manager.external_ref er
           WHERE er.tenant_id = $1 AND er.entity_kind = 'person' AND er.external_type = 'beneficiario'
             AND er.entity_id = am.person_id ORDER BY er.external_id LIMIT 1) AS aluno_ext
    FROM lead_manager.account_member am
    JOIN lead_manager.person p ON p.id = am.person_id
   WHERE am.tenant_id = $1 AND am.bond IN ('beneficiario', 'pagador')
     AND am.account_id IN (SELECT account_id FROM alvo)
)
SELECT a.*,
       (SELECT json_build_object('personId', m.person_id, 'nome', m.nome, 'telefone', m.telefone, 'alunoExt', m.aluno_ext)
          FROM membros m WHERE m.account_id = a.account_id AND m.bond = 'beneficiario'
         ORDER BY m.nome, m.person_id LIMIT 1) AS beneficiario,
       (SELECT json_build_object('personId', m.person_id, 'nome', m.nome, 'telefone', m.telefone)
          FROM membros m WHERE m.account_id = a.account_id AND m.bond = 'pagador'
         ORDER BY m.nome, m.person_id LIMIT 1) AS pagador,
       EXISTS (
         SELECT 1 FROM lead_manager.account_member b
           JOIN lead_manager.service_account s2 ON s2.id = b.account_id
          WHERE b.tenant_id = $1 AND s2.tenant_id = $1 AND b.bond = 'beneficiario'
            AND b.person_id IN (SELECT m.person_id FROM membros m WHERE m.account_id = a.account_id AND m.bond = 'beneficiario')
            AND s2.id <> a.account_id
            AND s2.ini_vigencia < a.ini_vigencia::date
            -- contratação que não aconteceu não faz de ninguém ex-aluno
            AND s2.fonte_ausente_em IS NULL
            AND (s2.status IS NULL OR s2.status <> 'Cancelado')
            -- ainda vigente quando este começou (aluno somando outra aula), ou parou há no máximo $4 dias
            AND coalesce(s2.fim_vigencia, s2.ini_vigencia) >= (a.ini_vigencia::date - $4::int)
       ) AS eh_renovacao,
       EXISTS (
         SELECT 1 FROM lead_manager.internal_contacts ic
           JOIN membros m ON m.account_id = a.account_id AND m.telefone IS NOT NULL
          WHERE ic.tenant_id = $1
            AND lead_manager.br_phone_key(ic.phone) = lead_manager.br_phone_key(m.telefone)
       ) AS contato_interno
  FROM alvo a
 ORDER BY a.ini_vigencia, a.account_id`;

const SQL_CONFIG = `
SELECT t.name AS tenant_nome, t.horario_comercial,
       ac.boas_vindas_modo, ac.boas_vindas_alerta_dias, ac.boas_vindas_variaveis, ac.boas_vindas_modelo,
       ac.boas_vindas_ativado_em,
       lc.school_name
  FROM lead_manager.tenants t
  LEFT JOIN lead_manager.automacao_config ac ON ac.tenant_id = t.id
  LEFT JOIN lead_manager.tenant_lead_config lc ON lc.tenant_id = t.id
 WHERE t.id = $1`;

const SQL_ETAPAS = `
SELECT id, ordem, nome, ancora, quando, repeticoes, contrato_curto, texto_titular, texto_responsavel,
       anexo_id, anexo_sugerido, entregue_por, ativo
  FROM lead_manager.boas_vindas_etapa
 WHERE tenant_id = $1
 ORDER BY ordem`;

const SQL_MODELO = `
SELECT ('modelo:' || modelo_slug || ':' || ordem) AS id, ordem, nome, ancora, quando, repeticoes, contrato_curto,
       texto_titular, texto_responsavel, NULL::uuid AS anexo_id, anexo_sugerido, entregue_por, true AS ativo
  FROM lead_manager.boas_vindas_modelo_etapa
 WHERE modelo_slug = $1
 ORDER BY ordem`;

const SQL_TOQUES = `
SELECT id, account_id, etapa_id, repeticao, status, bloqueio, motivo, phone,
       due_at, enviado_em, texto_final, versao, person_id, anexo_id, to_char(ancora_data, 'YYYY-MM-DD') AS ancora_data
  FROM lead_manager.boas_vindas_toque
 WHERE tenant_id = $1 AND account_id = ANY($2::uuid[])`;

// Grava criação/atualização. NUNCA mexe em mensagem que a recepção já tratou (aprovado, enviado,
// descartado, erro) e não reescreve a linha se nada mudou.
const SQL_UPSERT_TOQUE = `
INSERT INTO lead_manager.boas_vindas_toque
  (tenant_id, account_id, person_id, etapa_id, repeticao, ancora_data, due_at, versao, phone,
   destinatario_nome, cliente_nome, texto_final, anexo_id, status, bloqueio, motivo, auto)
VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, false)
ON CONFLICT (tenant_id, account_id, etapa_id, repeticao) DO UPDATE SET
  person_id = EXCLUDED.person_id, ancora_data = EXCLUDED.ancora_data, due_at = EXCLUDED.due_at,
  versao = EXCLUDED.versao, phone = EXCLUDED.phone, destinatario_nome = EXCLUDED.destinatario_nome,
  cliente_nome = EXCLUDED.cliente_nome, texto_final = EXCLUDED.texto_final, anexo_id = EXCLUDED.anexo_id,
  status = EXCLUDED.status, bloqueio = EXCLUDED.bloqueio, motivo = EXCLUDED.motivo, updated_at = now()
WHERE boas_vindas_toque.status IN ('pendente', 'bloqueado', 'fora_da_janela')
  AND (boas_vindas_toque.due_at, boas_vindas_toque.status, boas_vindas_toque.bloqueio, boas_vindas_toque.texto_final,
       boas_vindas_toque.phone, boas_vindas_toque.motivo, boas_vindas_toque.versao, boas_vindas_toque.anexo_id)
      IS DISTINCT FROM
      (EXCLUDED.due_at, EXCLUDED.status, EXCLUDED.bloqueio, EXCLUDED.texto_final,
       EXCLUDED.phone, EXCLUDED.motivo, EXCLUDED.versao, EXCLUDED.anexo_id)
RETURNING id, (xmax = 0) AS criado`;

function _jsonb(v, padrao) {
  if (v == null) return padrao;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return padrao; } }
  return v;
}

function configDaLinha(row) {
  const r = row || {};
  return {
    tenantNome: r.tenant_nome || null,
    horario: _jsonb(r.horario_comercial, null),
    modo: r.boas_vindas_modo || 'desligado',
    alertaDias: r.boas_vindas_alerta_dias || 21,
    variaveis: _jsonb(r.boas_vindas_variaveis, {}) || {},
    modelo: r.boas_vindas_modelo || null,
    ativadoEm: r.boas_vindas_ativado_em ? new Date(r.boas_vindas_ativado_em).getTime() : null,
    empresa: r.school_name || r.tenant_nome || null,
  };
}

function etapaDaLinha(row) {
  return { ...row, quando: _jsonb(row.quando, {}) };
}

function contratoDaLinha(row) {
  return {
    accountId: row.account_id,
    iniVigencia: row.ini_vigencia,
    dataMatricula: row.data_matricula || null,   // null = contrato sem a data; quem lê cai em iniVigencia
    fimVigencia: row.fim_vigencia,
    servico: row.servico_label || null,
    periodicidade: row.periodicidade || null,
    professorNome: row.professor_nome || null,
    contratoExt: row.contrato_ext != null ? String(row.contrato_ext) : null,
    beneficiario: _jsonb(row.beneficiario, null),
    pagador: _jsonb(row.pagador, null),
    ehRenovacao: row.eh_renovacao === true,
    contatoInterno: row.contato_interno === true,
  };
}

async function carregarConfig(c, tenantId) {
  return configDaLinha((await c.query(SQL_CONFIG, [tenantId])).rows[0]);
}
async function carregarEtapas(c, tenantId) {
  return (await c.query(SQL_ETAPAS, [tenantId])).rows.map(etapaDaLinha);
}
async function carregarModelo(c, slug = MODELO_PADRAO) {
  return (await c.query(SQL_MODELO, [slug])).rows.map(etapaDaLinha);
}
async function carregarContratos(c, tenantId, { hoje, janelaDias = 60, gapRenovacaoDias = RENOVACAO_GAP_DIAS }) {
  return (await c.query(SQL_CONTRATOS, [tenantId, hoje, janelaDias, gapRenovacaoDias])).rows.map(contratoDaLinha);
}
// INCLUSÃO MANUAL (ADR-050 §21): contratos que a recepção mandou entrar apesar da régua os ter
// deixado de fora. Devolve um Set de account_id.
async function carregarInclusoes(c, tenantId, accountIds) {
  if (!accountIds.length) return new Set();
  const { rows } = await c.query(
    'SELECT account_id FROM lead_manager.boas_vindas_inclusao WHERE tenant_id = $1 AND account_id = ANY($2::uuid[])',
    [tenantId, accountIds]);
  return new Set(rows.map((r) => r.account_id));
}
async function incluirManual(c, tenantId, accountId, { por, motivoOriginal = null }) {
  const { rows } = await c.query(
    `INSERT INTO lead_manager.boas_vindas_inclusao (tenant_id, account_id, motivo_original, incluido_por)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, account_id) DO NOTHING
     RETURNING account_id`, [tenantId, accountId, motivoOriginal, String(por || '').slice(0, 80)]);
  return rows.length > 0;   // false = já estava incluído
}
async function desfazerInclusao(c, tenantId, accountId) {
  const { rowCount } = await c.query(
    'DELETE FROM lead_manager.boas_vindas_inclusao WHERE tenant_id = $1 AND account_id = $2', [tenantId, accountId]);
  return rowCount > 0;
}

async function carregarToques(c, tenantId, accountIds) {
  if (!accountIds.length) return [];
  return (await c.query(SQL_TOQUES, [tenantId, accountIds])).rows;
}

async function gravarToque(c, tenantId, t) {
  const { rows } = await c.query(SQL_UPSERT_TOQUE, [
    tenantId, t.accountId, t.personId, t.etapaId, t.repeticao, t.ancoraData, new Date(t.dueAt).toISOString(),
    t.versao, t.phone, t.destinatarioNome, t.clienteNome, t.textoFinal, t.anexoId, t.status, t.bloqueio, t.motivo,
  ]);
  if (!rows.length) return 'sem_mudanca';
  return rows[0].criado ? 'criado' : 'atualizado';
}

// ── Alerta de cliente que não começou (E17-05) ───────────────────────────────────────────────────
// Abre ou atualiza. Fechado pelo sistema (ex.: o prazo da unidade subiu) reabre; DISPENSADO pela recepção
// só tem os números atualizados e continua dispensado.
const SQL_UPSERT_ALERTA = `
INSERT INTO lead_manager.boas_vindas_alerta
  (tenant_id, account_id, tipo, ini_vigencia, dias, phone, destinatario_nome, cliente_nome, proximo_atendimento)
VALUES ($1, $2, 'sem_primeiro_atendimento', $3::date, $4, $5, $6, $7, $8)
ON CONFLICT (tenant_id, account_id, tipo) DO UPDATE SET
  dias = EXCLUDED.dias, phone = EXCLUDED.phone, destinatario_nome = EXCLUDED.destinatario_nome,
  cliente_nome = EXCLUDED.cliente_nome, proximo_atendimento = EXCLUDED.proximo_atendimento,
  status = CASE WHEN boas_vindas_alerta.status = 'resolvido' AND boas_vindas_alerta.resolvido_por = 'sistema'
                THEN 'aberto' ELSE boas_vindas_alerta.status END,
  resolvido_em = CASE WHEN boas_vindas_alerta.status = 'resolvido' AND boas_vindas_alerta.resolvido_por = 'sistema'
                THEN NULL ELSE boas_vindas_alerta.resolvido_em END,
  resolvido_por = CASE WHEN boas_vindas_alerta.status = 'resolvido' AND boas_vindas_alerta.resolvido_por = 'sistema'
                THEN NULL ELSE boas_vindas_alerta.resolvido_por END,
  observacao = CASE WHEN boas_vindas_alerta.status = 'resolvido' AND boas_vindas_alerta.resolvido_por = 'sistema'
                THEN NULL ELSE boas_vindas_alerta.observacao END,
  atualizado_em = now()
RETURNING id, (xmax = 0) AS criado`;

// Fecha os abertos que não precisam mais de alerta. motivo: 'comecou' | 'fora_da_janela' | 'abaixo_do_prazo'.
const SQL_FECHAR_ALERTA = `
UPDATE lead_manager.boas_vindas_alerta
   SET status = 'resolvido', resolvido_em = now(), resolvido_por = 'sistema', observacao = $3, atualizado_em = now()
 WHERE tenant_id = $1 AND account_id = $2 AND tipo = 'sem_primeiro_atendimento' AND status = 'aberto'
RETURNING id`;

const SQL_ALERTAS_ABERTOS = `
SELECT account_id FROM lead_manager.boas_vindas_alerta
 WHERE tenant_id = $1 AND tipo = 'sem_primeiro_atendimento' AND status = 'aberto'`;

async function gravarAlerta(c, tenantId, a) {
  const { rows } = await c.query(SQL_UPSERT_ALERTA, [
    tenantId, a.accountId, a.iniVigencia, a.dias, a.phone || null, a.destinatarioNome || null, a.clienteNome || null,
    a.proximoAtendimento ? new Date(a.proximoAtendimento).toISOString() : null,
  ]);
  return rows[0].criado ? 'criado' : 'atualizado';
}
async function fecharAlerta(c, tenantId, accountId, motivo) {
  return (await c.query(SQL_FECHAR_ALERTA, [tenantId, accountId, motivo])).rows.length > 0;
}
async function carregarAlertasAbertos(c, tenantId) {
  return (await c.query(SQL_ALERTAS_ABERTOS, [tenantId])).rows.map((r) => r.account_id);
}

module.exports = {
  MODELO_PADRAO, RENOVACAO_PRIMEIRO_MARCO_DIAS,
  SQL_CONTRATOS, SQL_CONFIG, SQL_ETAPAS, SQL_MODELO, SQL_TOQUES, SQL_UPSERT_TOQUE,
  SQL_UPSERT_ALERTA, SQL_FECHAR_ALERTA, SQL_ALERTAS_ABERTOS,
  configDaLinha, etapaDaLinha, contratoDaLinha,
  carregarConfig, carregarEtapas, carregarModelo, carregarContratos, carregarToques, gravarToque,
  carregarInclusoes, incluirManual, desfazerInclusao,
  gravarAlerta, fecharAlerta, carregarAlertasAbertos,
};
