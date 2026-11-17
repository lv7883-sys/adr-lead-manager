'use strict';
//
// avisoDispositivo.js — MANDA O AVISO DE LEAD NOVO PARA OS APARELHOS (via dashboard).
//
// Pedido do Leo, 16/11/2026: o popup e o número no ícone têm de aparecer NO INSTANTE em que o
// lead chega, inclusive no celular com o navegador fechado. Ver docs/proposta-aviso-lead-novo.md.
//
// ─── POR QUE O LEAD MANAGER NÃO MANDA O PUSH DIRETO ───────────────────────────────────────────
//
// Quem sabe que o lead nasceu é este serviço. Quem sabe QUEM são as pessoas (usuários, sessões,
// papéis) e quais aparelhos elas inscreveram é o dashboard. Duplicar a tabela de aparelhos aqui
// seria duas fontes para a mesma pergunta; então este módulo só avisa, e o dashboard entrega.
//
// Credencial: reusa o canal interno que JÁ EXISTE (`X-Api-Token` + `INTERNAL_API_TOKEN`, ver
// dashboard/routes/api.js). Nenhum segredo novo foi criado — o que seria mais uma chave sem
// registro de rotação, e o inventário de segredos deste projeto já tem sete.
//
// ─── O AVISO É EM DOIS TEMPOS, E ISSO É O DESENHO, NÃO UM REMENDO ──────────────────────────────
//
// O lead só EXISTE depois de a IA classificar a mensagem (src/engine.js:528). Entre a mensagem
// chegar e isso acontecer passa um tempo que ninguém mediu — e em dia de IA fora do ar, não passa
// nunca. Se o aviso esperasse por ela, "no instante" seria mentira. Então:
//
//   1º tempo (`avisarContatoNovo`) — a mensagem chegou de alguém que não tem lead e não está na
//      lista de supressão. Sai em ~1 s, SEM IA: "Contato novo — (19) 9xxxx-xxxx".
//   2º tempo (`avisarLeadNovo`) — a IA terminou. O MESMO aviso (mesma `tag`) é SUBSTITUÍDO na
//      tela por "Lead novo: Mariana — teclado", sem vibrar de novo.
//
// ⚠ A `tag` é o que faz os dois tempos serem UM aviso e não dois. Ela é derivada do contato
//   (`lead-<chave do telefone>`), então o 2º tempo encontra o 1º na tela de qualquer aparelho —
//   inclusive de quem recebeu o 1º tempo e nem olhou ainda.
//
// ⚠ POR QUE O NÚMERO DO ÍCONE VIAJA JUNTO: a Apple proíbe push invisível (todo push tem de mostrar
//   notificação, senão o Safari revoga a permissão do site). Logo não existe "push silencioso só
//   para corrigir o número". A correção pega carona neste aviso, que ia aparecer de todo jeito.
//
const logger = require('./logger');
const semAtendimento = require('./semAtendimentoHumano');
const { withTenant } = require('./db');
const telBR = require('./telefoneBR');

const BASE = (process.env.DASHBOARD_INTERNAL_URL || 'http://adr-scheduler-dashboard:3000').replace(/\/+$/, '');
const TOKEN = process.env.INTERNAL_API_TOKEN || '';
// Curto de propósito: isto roda no caminho de entrada da mensagem. Um dashboard lento não pode
// atrasar a ingestão — o aviso é importante, a mensagem do cliente é mais.
const TIMEOUT_MS = Number(process.env.AVISO_DISPOSITIVO_TIMEOUT_MS || 4000);

let _ultimaFalha = null;

// ⚠ QUEM MANDA É O `tenant_id`, e a tradução para a unidade do dashboard é LÁ, não aqui.
//   O Lead Manager não tem (e não deve ter) a coluna de franquia: o vínculo mora em
//   `app.franquia.lead_tenant_id`, no dashboard, com fonte única em lib/tenant-franquia.js —
//   escrita justamente porque aquela expressão estava copiada em SEIS arquivos e, pior, resolvia
//   tudo por uma variável de ambiente global (vazaria a unidade nova para a antiga). Guardar uma
//   cópia do vínculo deste lado seria a sétima.

/**
 * O POST para o dashboard. Best-effort e NUNCA lança: o aviso é importante, mas perder a mensagem
 * do cliente por causa dele seria trocar um problema por um pior.
 *
 * ⚠ Falha é REGISTRADA (uma vez por causa). "Não recebi aviso nenhum" é a reclamação que este
 *   recurso vai gerar, e sem rastro aqui a investigação começa no escuro.
 */
async function _enviar(corpo, log) {
  if (!TOKEN) {
    if (_ultimaFalha !== 'sem_token') {
      _ultimaFalha = 'sem_token';
      log.warn('aviso_dispositivo.inerte', { causa: 'INTERNAL_API_TOKEN ausente' });
    }
    return { ok: false, causa: 'sem_token' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/api/avisos/lead`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-token': TOKEN },
      body: JSON.stringify(corpo),
    });
    if (!res.ok) {
      if (_ultimaFalha !== `http_${res.status}`) {
        _ultimaFalha = `http_${res.status}`;
        log.warn('aviso_dispositivo.falhou', { status: res.status });
      }
      return { ok: false, causa: `http_${res.status}` };
    }
    _ultimaFalha = null;
    const j = await res.json().catch(() => ({}));
    log.info('aviso_dispositivo.enviado', { tag: corpo.tag, enviados: j.enviados ?? null, tempo: corpo.tempo });
    return { ok: true, ...j };
  } catch (e) {
    const causa = e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'erro';
    if (_ultimaFalha !== causa) {
      _ultimaFalha = causa;
      log.warn('aviso_dispositivo.falhou', { causa });
    }
    return { ok: false, causa };
  } finally {
    clearTimeout(timer);
  }
}

// A tag tem de ser a MESMA nos dois tempos para o segundo substituir o primeiro na tela. Derivada
// do contato, não do lead: no 1º tempo o lead ainda não existe.
//
// ⚠ E derivada da CHAVE CANÔNICA do telefone, não dos dígitos crus — porque as duas pontas não
//   recebem a mesma string: o 1º tempo usa `msg.externalId` (o jid, '5519987654321') e o 2º usa
//   `phone` (o que foi gravado, '+55 19 98765-4321' ou sem o 9º dígito). Dígito cru faria as tags
//   divergirem justamente no caso do 9º dígito — e o sintoma seria DOIS avisos do mesmo lead no
//   celular, um dizendo "contato novo" e outro "lead novo".
//
//   `chaveTelefone` é a única cópia JS da `lead_manager.br_phone_key` (sem 55, sem o 9º dígito) e
//   vive em src/boasVindasRegua.js. Importar de um módulo de boas-vindas é esquisito de ler, e é
//   melhor que a alternativa: uma segunda cópia da mesma régua.
const { chaveTelefone } = require('./boasVindasRegua');
const tagDoContato = (chave) => {
  const k = chaveTelefone(chave);
  return `lead-${k || 'desconhecido'}`;
};

// Telefone no aviso: só os últimos 4 dígitos à mostra. O aviso aparece na tela de bloqueio, onde
// qualquer um vê — e no 1º tempo o telefone é a única coisa que temos para identificar quem é.
function _telefoneDiscreto(chave) {
  const d = String(chave || '').replace(/\D/g, '');
  if (d.length < 4) return 'número novo';
  return `•••• ${d.slice(-4)}`;
}

/**
 * Vale avisar no 1º tempo? Duas perguntas, as duas sem IA e as duas baratas:
 *
 *   • já existe lead para este contato? → então não é "contato novo": é conversa em andamento, e
 *     avisar de novo transformaria cada resposta de cliente em popup. O aviso de lead novo tem de
 *     doer só uma vez por pessoa.
 *   • o número está na lista de supressão (equipe, aluno, fornecedor)? → não é lead, e avisar aqui
 *     queimaria a confiança no aviso mais rápido que qualquer outra coisa.
 *
 * ⚠ A supressão usa `telBR.matchKeys`, que é exatamente a régua do leitor que já existe
 *   (`_lookupRole` em src/engine.js). Aqui eu preferiria `br_phone_key` por coerência com o resto
 *   deste arquivo — mas, para a MESMA pergunta, vale a régua de quem já a responde: duas réguas
 *   discordando sobre "é da equipe?" produziriam aviso para a recepcionista sobre ela mesma.
 */
async function _ehContatoNovo(tenantId, chave, deps = {}) {
  const q = deps.withTenant || withTenant;
  const chaves = chave ? telBR.matchKeys(chave) : [];
  if (!chaves.length) return { sim: false, motivo: 'sem_telefone' };
  const r = await q(tenantId, async (c) => (await c.query(
    `SELECT
       (SELECT count(*) FROM leads
         WHERE tenant_id = $1
           AND br_phone_key(coalesce(phone, '')) <> ''
           AND br_phone_key(coalesce(phone, '')) = br_phone_key($2))::int AS leads,
       (SELECT count(*) FROM contact_role_member m
          JOIN contact_role cr ON cr.id = m.role_id
         WHERE m.tenant_id = $1
           AND cr.suppression = 'hard'
           AND regexp_replace(m.phone, '[^0-9]', '', 'g') = ANY($3::text[]))::int AS suprimidos`,
    [tenantId, String(chave), chaves])).rows[0]);
  if (r.suprimidos > 0) return { sim: false, motivo: 'contato_suprimido' };
  if (r.leads > 0) return { sim: false, motivo: 'lead_ja_existe' };
  return { sim: true, motivo: null };
}

/**
 * 1º TEMPO — chegou mensagem de alguém que ainda não é lead. Sem IA, em ~1 segundo.
 *
 * @param {object} tenant   { id }
 * @param {object} p        { chaveContato, nomeContato? }
 */
async function avisarContatoNovo(tenant, p = {}, deps = {}) {
  const log = (deps.logger || logger).child({ tenant_id: tenant.id, fn: 'avisarContatoNovo' });
  try {
    const vale = await _ehContatoNovo(tenant.id, p.chaveContato, deps);
    if (!vale.sim) { log.info('aviso_dispositivo.1o_tempo_pulado', { motivo: vale.motivo }); return { ok: false, causa: vale.motivo }; }
    // O número do ícone é a conta de D1. Falha dela NÃO cancela o aviso: melhor aviso sem número
    // que nenhum aviso — e um 0 inventado diria "está tudo atendido", que é pior que ausência.
    let badge;
    try { badge = await semAtendimento.contar(tenant.id); } catch (e) {
      log.warn('aviso_dispositivo.badge_indisponivel', { error: e.message });
    }
    const quem = (p.nomeContato && String(p.nomeContato).trim()) || _telefoneDiscreto(p.chaveContato);
    return _enviar({
      tenant_id: tenant.id,
      tempo: 1,
      tag: tagDoContato(p.chaveContato),
      titulo: 'Contato novo',
      // Honesto sobre o que ainda não se sabe: no 1º tempo ninguém classificou nada.
      corpo: `${quem} mandou mensagem agora.`,
      url: '/',
      badge,
    }, log);
  } catch (e) {
    (deps.logger || logger).warn('aviso_dispositivo.unhandled', { tenant_id: tenant.id, error: e.message });
    return { ok: false, causa: 'erro' };
  }
}

/**
 * 2º TEMPO — a IA terminou e o lead existe. Substitui o aviso do 1º tempo na tela.
 *
 * @param {object} tenant
 * @param {object} p  { chaveContato, leadId, nome, interesse }
 */
async function avisarLeadNovo(tenant, p = {}, deps = {}) {
  const log = (deps.logger || logger).child({ tenant_id: tenant.id, fn: 'avisarLeadNovo' });
  try {
    let badge;
    try { badge = await semAtendimento.contar(tenant.id); } catch (e) {
      log.warn('aviso_dispositivo.badge_indisponivel', { error: e.message });
    }
    const nome = (p.nome && String(p.nome).trim()) || _telefoneDiscreto(p.chaveContato);
    const interesse = (p.interesse && String(p.interesse).trim()) || null;
    return _enviar({
      tenant_id: tenant.id,
      tempo: 2,
      tag: tagDoContato(p.chaveContato),
      titulo: 'Lead novo',
      corpo: interesse ? `${nome} — ${interesse}` : `${nome} quer informações.`,
      // Cai direto no lead quando sabemos qual é; senão, na Caixa de Entrada.
      url: p.leadId ? `/leads/${p.leadId}` : '/',
      badge,
      // Não vibra de novo: é o MESMO aviso ficando mais específico, não um segundo lead.
      revibrar: false,
    }, log);
  } catch (e) {
    (deps.logger || logger).warn('aviso_dispositivo.unhandled', { tenant_id: tenant.id, error: e.message });
    return { ok: false, causa: 'erro' };
  }
}

module.exports = {
  avisarContatoNovo, avisarLeadNovo,
  tagDoContato, _telefoneDiscreto, _ehContatoNovo,
};
