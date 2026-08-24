'use strict';
//
// sync-professores.js — GARANTE que TODO professor que aparece nos contratos tenha uma Pessoa
// canônica (lead_manager.person) + external_ref(person,'professor', id-ou-slug), fechando
// lead_manager.service_account.professor_person_id (o campo que o dashboard consome).
//
// POR QUÊ: o dashboard enriquece service_account.professor_nome (do Excel/bi_raw) e resolve
// nome → person.id via external_ref(professor). Mas SÓ ~22 professores tinham external_ref, então
// ~61 contratos ficavam com professor_nome mas SEM professor_person_id (nome sem pessoa p/ casar).
// Este passo cria as pessoas/refs que faltavam — um gap do CADASTRO (LM), não do enriquecimento.
//
// FONTES (tudo do próprio LM — sem depender do schema bi_raw do dashboard):
//   - QUEM são os professores: DISTINCT service_account.professor_nome do tenant (já enriquecido).
//   - professor_id da Extranet (p/ chavear o external_ref): resources.resource (type='TEACHER'),
//     que o Sincronizador de Recursos do LM já popula (name = nome do cadastro, external_ref = id).
//     Casamento por NOME normalizado; quando não casa, usa uma chave determinística por nome.
//
// INVARIANTE-CHAVE: a Pessoa associada a um `professor_nome` SEMPRE tem display_name = esse nome.
// Isso mantém a resolução do LM idêntica à do dashboard (058b casa por display_name = professor_nome),
// então os dois escritores nunca divergem. professor_person_id só é PREENCHIDO onde está NULL
// (fecha o gap; nunca sobrescreve valor já resolvido).
//
// Idempotente, aditivo, multi-tenant: roda sob withTenant (RLS confina ao tenant). NÃO faz fetch.
//

const logger = require('../logger');

const CADASTRO_SOURCE = 'extranet';

// normaliza p/ casar nomes entre fontes: sem acento, minúsculo, sem "prof(a).", só [a-z0-9 ], espaço único.
function normNome(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bprof(?:essor)?a?\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
// chave determinística por nome (fallback quando não há id da Extranet). Baseada no nome NORMALIZADO
// — dois nomes que só diferem em caixa/acento convergem (mesmo professor); grafias realmente
// distintas geram chaves distintas (cada uma com a sua pessoa, p/ o dashboard casar por display_name).
const slugNome = (s) => 'nome:' + normNome(s).replace(/\s+/g, '-');

// mapa nome_normalizado → id de cadastro da Extranet (resources.resource TEACHER). Degrada gracioso:
// se o schema resources não existir p/ este tenant, devolve mapa vazio (tudo cai no caminho por nome).
async function _teacherMap(c, tid) {
  try {
    const rows = (await c.query(
      `SELECT external_ref AS ext_id, name FROM resources.resource
        WHERE tenant_id=$1 AND type='TEACHER' AND external_ref IS NOT NULL AND btrim(external_ref) <> ''`,
      [tid])).rows;
    const m = new Map();
    for (const r of rows) {
      const k = normNome(r.name);
      if (k && !m.has(k)) m.set(k, String(r.ext_id));   // 1ª ocorrência vence (nomes distintos → ids distintos)
    }
    return m;
  } catch (e) {
    logger.warn('sync_professores.teacher_map_indisponivel', { tenant_id: tid, error: e.message });
    return new Map();
  }
}

// Pessoa-professor com display_name = nome: reusa uma que JÁ tenha external_ref(professor) e esse
// display_name; senão cria BARE. Mantém a invariante (display_name == professor_nome).
async function _professorPersonByName(c, tid, nome) {
  const ex = (await c.query(
    `SELECT p.id FROM lead_manager.person p
       JOIN lead_manager.external_ref er
         ON er.entity_id=p.id AND er.entity_kind='person' AND er.external_type='professor'
      WHERE p.tenant_id=$1 AND p.display_name=$2 LIMIT 1`,
    [tid, nome])).rows[0];
  if (ex) return { id: ex.id, novo: false };
  const id = (await c.query(
    `INSERT INTO lead_manager.person (tenant_id, display_name) VALUES ($1,$2) RETURNING id`,
    [tid, nome])).rows[0].id;
  return { id, novo: true };
}

async function _insertRef(c, tid, personId, extId) {
  const r = await c.query(
    `INSERT INTO lead_manager.external_ref (tenant_id, entity_kind, entity_id, source, external_type, external_id)
     VALUES ($1,'person',$2,$3,'professor',$4)
     ON CONFLICT (tenant_id, source, external_type, external_id) DO NOTHING RETURNING id`,
    [tid, personId, CADASTRO_SOURCE, String(extId)]);
  return r.rowCount > 0;
}

// external_ref(professor, extId) → { personId, display_name } (ou null).
async function _refPerson(c, tid, extId) {
  const r = (await c.query(
    `SELECT er.entity_id AS person_id, p.display_name
       FROM lead_manager.external_ref er
       JOIN lead_manager.person p ON p.id=er.entity_id
      WHERE er.tenant_id=$1 AND er.source=$2 AND er.external_type='professor' AND er.external_id=$3`,
    [tid, CADASTRO_SOURCE, String(extId)])).rows[0];
  return r ? { personId: r.person_id, display_name: r.display_name } : null;
}

// Garante Pessoa + external_ref p/ UM professor_nome. Preferência de chave: id da Extranet quando
// LIVRE (não ocupado por outro nome); senão chave por nome. Devolve { personId, chave }.
async function _ensureProfessor(c, tid, nome, teacherByNorm, st) {
  const extId = teacherByNorm.get(normNome(nome)) || null;

  if (extId) {
    const hit = await _refPerson(c, tid, extId);
    if (hit) {
      if (!hit.display_name || hit.display_name === nome) {
        if (!hit.display_name) {
          await c.query(`UPDATE lead_manager.person SET display_name=$2, updated_at=now() WHERE id=$1`, [hit.personId, nome]);
        }
        st.por_id++;
        return { personId: hit.personId, chave: 'id' };
      }
      // id já pertence a OUTRO nome (mesmo cadastro, grafia diferente no Excel) → cai p/ chave por nome
    } else {
      const pp = await _professorPersonByName(c, tid, nome);
      if (pp.novo) st.pessoas_novas++;
      if (await _insertRef(c, tid, pp.id, String(extId))) st.refs_novos++;
      st.por_id++;
      return { personId: pp.id, chave: 'id' };
    }
  }

  // caminho por NOME (sem id da Extranet, ou id em conflito)
  const pp = await _professorPersonByName(c, tid, nome);
  if (pp.novo) st.pessoas_novas++;
  if (await _insertRef(c, tid, pp.id, slugNome(nome))) st.refs_novos++;
  st.por_nome++;
  return { personId: pp.id, chave: 'nome' };
}

// Reconcilia os professores dos contratos de UM tenant. `c` já em transação + app.current_tenant.
async function syncProfessores(c, { tenantId }) {
  const st = { nomes: 0, pessoas_novas: 0, refs_novos: 0, por_id: 0, por_nome: 0, contratos_fechados: 0 };

  const nomes = (await c.query(
    `SELECT DISTINCT btrim(professor_nome) AS nome
       FROM lead_manager.service_account
      WHERE tenant_id=$1 AND professor_nome IS NOT NULL AND btrim(professor_nome) <> ''`,
    [tenantId])).rows.map((r) => r.nome);
  st.nomes = nomes.length;
  if (!nomes.length) return st;

  const teacherByNorm = await _teacherMap(c, tenantId);

  for (const nome of nomes) {
    const { personId } = await _ensureProfessor(c, tenantId, nome, teacherByNorm, st);
    // Fecha o gap: só onde ainda está NULL (nunca sobrescreve o que o enriquecimento já resolveu;
    // a invariante display_name==nome garante que o valor coincide com o do dashboard).
    const upd = await c.query(
      `UPDATE lead_manager.service_account
          SET professor_person_id=$2, updated_at=now()
        WHERE tenant_id=$1 AND btrim(professor_nome)=$3 AND professor_person_id IS NULL`,
      [tenantId, personId, nome]);
    st.contratos_fechados += upd.rowCount;
  }
  return st;
}

module.exports = { syncProfessores, normNome, slugNome };
