'use strict';
//
// Demonstração do Lead Manager para a MF8 (04/11/2026) — testes PUROS, sem banco.
//
// Cobrem três coisas diferentes, e vale saber qual é qual:
//
//   A. As INVARIANTES do tenant de demonstração (o que contém os efeitos externos). Errar aqui
//      é a unidade fictícia entrar nos laços de fundo ou ganhar permissão de mandar WhatsApp.
//   B. O AVALIADOR DE CHECK da camada 1, incluindo o que ele RECUSA. Avaliador que passa calado
//      numa expressão que não entendeu é pior que nenhum: vira trava com nome de trava.
//   C. A COERÊNCIA do cenário (telefone da conversa × do lead, destinatário do toque, nenhum
//      valor em dinheiro, determinismo).
//
// A conferência do plano contra o esquema REAL de produção está em demo-mf8-esquema.test.js,
// porque depende do dump congelado — e um teste que precisa de arquivo gerado não pode se
// misturar com os que rodam em qualquer máquina.
//
const { test } = require('node:test');
const assert = require('node:assert/strict');
const demo = require('../src/demo/tenant-demo');
const cenario = require('../src/demo/cenario-mf8');
const { avaliaCheck, normalizaDefinicao } = require('../src/demo/check-sql');
const { confere } = require('../src/demo/conformidade');

const TENANT = '11111111-2222-4333-8444-555555555555';
const HOJE = '2026-11-04';   // o dia da apresentação

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A. As invariantes do tenant de demonstração
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('o tenant de demonstração fica FORA de todos os laços de fundo (lead_manager_active=false)', () => {
  const t = demo.tenantDeDemonstracao({ slug: 'clinica-exemplo' });
  // tenants_active() é `WHERE lead_manager_active` (migr 031) e TODA rotina de fundo lê dela.
  assert.equal(t.lead_manager_active, false);
});

test('o tenant de demonstração tem is_demo=true — sem isso o portão do seed não existe', () => {
  const t = demo.tenantDeDemonstracao({ slug: 'clinica-exemplo' });
  assert.equal(t.is_demo, true);
  assert.equal(demo.ehTenantDeDemonstracao(t), true);
});

test('nenhuma credencial de envio: sem token, não há remetente para resolver', () => {
  const t = demo.tenantDeDemonstracao({ slug: 'clinica-exemplo' });
  assert.equal(t.evolution_token_enc, null);
  assert.equal(t.zapi_token, null);
  // E o nome da instância se denuncia: quem a procurar na Evolution lê que ela não existe.
  assert.match(t.evolution_instance, /^demo-sem-whatsapp-/);
});

test('o envio automático de renovação fica DESLIGADO (a tela mostra o interruptor)', () => {
  const p = demo.perfilDaAssistente();
  assert.equal(p.renovacao_auto_envio, false);
  // E o módulo de boas-vindas, que dispara mensagem de hora em hora, fica fora.
  assert.equal(p.boas_vindas_modo, 'desligado');
});

test('a lista de cursos fica VAZIA — preenchê-la faria a IA oferecer procedimento clínico', () => {
  const c = demo.configDaUnidade({ nomeExibido: 'Clínica X' });
  assert.deepEqual(c.available_instruments, []);
  assert.equal(c.notification_whatsapp, '');   // sem destino de notificação
});

test('ehTenantDeDemonstracao falha FECHADO: tenant sem a flag (ou sem a migração) é recusado', () => {
  assert.equal(demo.ehTenantDeDemonstracao(null), false);
  assert.equal(demo.ehTenantDeDemonstracao({}), false);               // banco sem a migr 187
  assert.equal(demo.ehTenantDeDemonstracao({ is_demo: 'true' }), false); // texto não vale
  assert.equal(demo.ehTenantDeDemonstracao({ is_demo: 1 }), false);
});

test('o portão é SQL: a subconsulta exige is_demo e devolve NULL em tenant real', () => {
  const sql = demo.sqlTenantSoSeDemo(1);
  assert.match(sql, /SELECT id FROM lead_manager\.tenants WHERE id = \$1 AND is_demo/);
  assert.throws(() => demo.sqlTenantSoSeDemo(0), /posição de parâmetro inválida/);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B. O avaliador de CHECK — e, principalmente, o que ele RECUSA
// ─────────────────────────────────────────────────────────────────────────────────────────────

// Os textos abaixo estão na forma que `pg_get_constraintdef` devolve, não na forma que a
// migração escreveu. É a mesma diferença que faz a camada 1 ler do banco e não do arquivo.
const CASOS = [
  ["CHECK ((kind = ANY (ARRAY['phone'::text, 'email'::text])))", { kind: 'phone' }, true],
  ["CHECK ((kind = ANY (ARRAY['phone'::text, 'email'::text])))", { kind: 'fax' }, false],
  ["CHECK ((bond = ANY (ARRAY['beneficiario'::text, 'pagador'::text, 'professor'::text])))", { bond: 'pagador' }, true],
  ["CHECK ((role = ANY (ARRAY['USER'::text, 'ASSISTANT'::text])))", { role: 'USER' }, true],
  ["CHECK ((conversation_kind = ANY (ARRAY['DIRECT'::text, 'GROUP'::text, 'COMMUNITY'::text])))", { conversation_kind: 'DIRECT' }, true],
  ["CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'EDITED'::text])))", { status: 'APPROVED' }, true],
  ["CHECK (((periodicidade IS NULL) OR (periodicidade = ANY (ARRAY['mensal'::text, 'anual'::text]))))", { periodicidade: 'anual' }, true],
  ["CHECK (((periodicidade IS NULL) OR (periodicidade = ANY (ARRAY['mensal'::text, 'anual'::text]))))", { periodicidade: 'quinzenal' }, false],
  ["CHECK ((btrim(nome) <> ''::text))", { nome: '   ' }, false],
  ["CHECK ((btrim(nome) <> ''::text))", { nome: ' Marina ' }, true],
  ['CHECK ((alerta_dias > 0))', { alerta_dias: 21 }, true],
  ['CHECK ((char_length(x) <= 10))', { x: 'abc' }, true],
  ['CHECK (NOT (a AND b))', { a: true, b: false }, true],
  ['CHECK ((is_group OR (x IS NULL)))', { is_group: false, x: null }, true],
  // Restrição REAL de automacao_config, achada ao rodar a camada 1 contra produção em 02/11/2026.
  // O avaliador recusava a expressão (função desconhecida); agora a entende.
  ["CHECK ((jsonb_typeof(v) = 'object'::text))", { v: '{"a":1}' }, true],
  ["CHECK ((jsonb_typeof(v) = 'object'::text))", { v: '[1,2]' }, false],
  ["CHECK ((jsonb_typeof(v) = 'object'::text))", { v: { a: 1 } }, true],
  // Coluna que o plano NÃO escreve: o banco põe o default, e o CHECK fica em desconhecido.
  ["CHECK ((jsonb_typeof(v) = 'object'::text))", {}, null],
  // Texto que não é json: devolve desconhecido em vez de chutar um tipo — quem recusa é o banco.
  ["CHECK ((jsonb_typeof(v) = 'object'::text))", { v: 'nao e json' }, null],
];

test('o avaliador acerta as formas de CHECK que este schema realmente usa', () => {
  for (const [def, linha, esperado] of CASOS) {
    assert.equal(avaliaCheck(normalizaDefinicao(def), linha), esperado,
      `errou em ${def} com ${JSON.stringify(linha)}`);
  }
});

test('LÓGICA DE TRÊS VALORES: valor nulo deixa o CHECK em desconhecido, e desconhecido PASSA', () => {
  // No PostgreSQL um CHECK só reprova quando dá FALSE. Avaliar isso com os dois valores do
  // JavaScript produziria reprovação FALSA — e reprovação falsa treina quem lê a ignorar.
  const def = normalizaDefinicao("CHECK ((kind = ANY (ARRAY['phone'::text, 'email'::text])))");
  assert.equal(avaliaCheck(def, { kind: null }), null);
  // Coluna que o plano nem escreve conta como nula: o banco vai pôr o default dela.
  assert.equal(avaliaCheck(def, {}), null);
  // E em conformidade.confere, `null` não entra na lista de problemas.
  const esquema = { tabelas: { 't': { colunas: { tenant_id: { nulo: false, temDefault: false }, kind: { nulo: true, temDefault: false } }, checks: ["CHECK ((kind = ANY (ARRAY['phone'::text])))"] } } };
  const plano = [{ tabela: 't', colunas: ['tenant_id', 'kind'], chaveConflito: ['tenant_id'], linhas: [[TENANT, null]] }];
  assert.deepEqual(confere(plano, esquema).problemas, []);
});

test('RECUSA em vez de chutar: expressão fora do subconjunto não passa calada', () => {
  assert.throws(() => avaliaCheck("CHECK ((x ~ '^[0-9]+$'))", { x: '1' }), /não suportado/);
  // Função que o avaliador NÃO conhece. (Até 02/11/2026 o exemplo aqui era `jsonb_typeof`, até a
  // camada 1 topar com ela em produção: foi recusada, eu olhei, e ela entrou na lista. É o laço
  // que o desenho pretende — recusar, ser visto, e então ser decidido por alguém.)
  assert.throws(() => avaliaCheck("CHECK ((to_tsvector(v) = 'x'))", { v: 'a' }),
    /não está na lista de funções conhecidas/);
  assert.throws(() => avaliaCheck('CHECK ((a + b) > 0)', { a: 1, b: 2 }), /não suportado/);
  // E a coluna que não existe na tabela é recusada, não tratada como nula.
  assert.throws(
    () => avaliaCheck('CHECK ((fantasma IS NULL))', {}, { colunasConhecidas: new Set(['real']) }),
    /não existe na tabela/);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// C. A conformidade pega o que precisa pegar — inclusive o erro de 31/10/2026
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ESQUEMA_MINIMO = {
  tabelas: {
    'x.t': {
      colunas: {
        id: { nulo: false, temDefault: true, gerada: false },
        tenant_id: { nulo: false, temDefault: false, gerada: false },
        marco: { nulo: false, temDefault: false, gerada: false },
        obrigatoria: { nulo: false, temDefault: false, gerada: false },
        br_key: { nulo: true, temDefault: false, gerada: true },
      },
      checks: ["CHECK ((marco = ANY (ARRAY['D-10'::text, 'D-2'::text])))"],
    },
  },
};
const bloco = (colunas, linhas) => [{ tabela: 'x.t', colunas, chaveConflito: ['id'], linhas }];

test('⭐ tabela que está no PLANO e não está no esquema congelado é PROBLEMA, nunca omissão', () => {
  // Este é o erro exato que matou a gravação do cenário do dashboard em 31/10/2026: a sexta de
  // oito tabelas ficou sem conferência e a suíte seguiu verde. A lista aqui sai do plano.
  const p = [{ tabela: 'x.nao_existe', colunas: ['tenant_id'], chaveConflito: ['tenant_id'], linhas: [[TENANT]] }];
  const r = confere(p, ESQUEMA_MINIMO);
  assert.equal(r.ok, false);
  assert.match(r.problemas.join('\n'), /está no PLANO e NÃO está no esquema congelado/);
});

test('coluna inexistente, coluna gerada e NOT NULL faltando viram problema', () => {
  const r1 = confere(bloco(['tenant_id', 'marco', 'obrigatoria', 'inventada'], [[TENANT, 'D-2', 'x', 1]]), ESQUEMA_MINIMO);
  assert.match(r1.problemas.join('\n'), /"inventada", que não existe na tabela/);

  const r2 = confere(bloco(['tenant_id', 'marco', 'obrigatoria', 'br_key'], [[TENANT, 'D-2', 'x', 'k']]), ESQUEMA_MINIMO);
  assert.match(r2.problemas.join('\n'), /é coluna GERADA/);

  const r3 = confere(bloco(['tenant_id', 'marco'], [[TENANT, 'D-2']]), ESQUEMA_MINIMO);
  assert.match(r3.problemas.join('\n'), /"obrigatoria" é NOT NULL e não tem default/);

  const r4 = confere(bloco(['tenant_id', 'marco', 'obrigatoria'], [[TENANT, 'D-2', null]]), ESQUEMA_MINIMO);
  assert.match(r4.problemas.join('\n'), /é NOT NULL e o plano manda null/);
});

test('valor fora do CHECK real é reprovado — e o plano certo passa', () => {
  const mau = confere(bloco(['tenant_id', 'marco', 'obrigatoria'], [[TENANT, 'D-45', 'x']]), ESQUEMA_MINIMO);
  assert.equal(mau.ok, false);
  assert.match(mau.problemas.join('\n'), /reprovada pela restrição/);

  const bom = confere(bloco(['tenant_id', 'marco', 'obrigatoria'], [[TENANT, 'D-2', 'x']]), ESQUEMA_MINIMO);
  assert.deepEqual(bom.problemas, []);
  assert.equal(bom.ok, true);
});

test('esquema congelado ausente LANÇA — a camada não finge que conferiu', () => {
  assert.throws(() => confere(bloco(['tenant_id'], [[TENANT]]), null), /esquema congelado ausente/);
  assert.throws(() => confere(bloco(['tenant_id'], [[TENANT]]), {}), /esquema congelado ausente/);
});

test('aridade errada (valores a menos que colunas) é problema, não erro silencioso', () => {
  const r = confere(bloco(['tenant_id', 'marco', 'obrigatoria'], [[TENANT, 'D-2']]), ESQUEMA_MINIMO);
  assert.match(r.problemas.join('\n'), /2 valores para 3 colunas/);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// D. A coerência do cenário
// ─────────────────────────────────────────────────────────────────────────────────────────────

const plano = () => cenario.plano({ tenantId: TENANT, hoje: HOJE });
const blocoDe = (p, tab) => p.find((b) => b.tabela === `lead_manager.${tab}`);
const comoObjetos = (b) => b.linhas.map((l) => Object.fromEntries(b.colunas.map((c, k) => [c, l[k]])));

test('NÃO HÁ SORTEIO: duas chamadas produzem o plano byte-a-byte igual', () => {
  assert.equal(JSON.stringify(plano()), JSON.stringify(plano()));
  // E o uuid de uma linha é derivado da chave declarada, não sorteado.
  assert.equal(cenario.idDe('pessoa', 'marina'), cenario.idDe('pessoa', 'marina'));
  assert.notEqual(cenario.idDe('pessoa', 'marina'), cenario.idDe('pessoa', 'helena'));
  assert.match(cenario.idDe('pessoa', 'marina'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('NÃO HÁ DINHEIRO: nenhum texto do cenário carrega valor', () => {
  // A regra do projeto é que o sorteio nunca toca em total de dinheiro. Aqui não há sorteio E
  // não há dinheiro: `service_account` não tem coluna de valor, e a trava de assunto proibido do
  // produto barra "valores" na saída — um preço no rascunho seria frase que a trava recusaria.
  const p = plano();
  const textos = [];
  for (const b of p) {
    comoObjetos(b).forEach((o) => {
      ['body', 'suggested_response', 'rascunho', 'estrategia', 'media_transcription',
        'plano_label', 'servico_label', 'desfecho_notas'].forEach((c) => {
        if (typeof o[c] === 'string' && o[c]) textos.push(`${b.tabela}.${c}: ${o[c]}`);
      });
    });
  }
  assert.ok(textos.length > 40, `esperava muitos textos no cenário, achei ${textos.length}`);
  const comValor = textos.filter((t) => /R\$|\breais\b|\d+[.,]\d{2}\b/i.test(t));
  assert.deepEqual(comValor, [], `textos com valor em dinheiro:\n${comValor.join('\n')}`);
});

test('o telefone da conversa e o do lead são os MESMOS dígitos — senão o lead não casa', () => {
  const p = plano();
  // leadk casa por regexp_replace(leads.phone) = regexp_replace(conversations.external_id).
  const telefonesDeConversa = new Set(comoObjetos(blocoDe(p, 'conversations')).map((c) => c.external_id));
  for (const l of comoObjetos(blocoDe(p, 'leads'))) {
    assert.ok(telefonesDeConversa.has(l.phone),
      `o lead ${l.name} tem telefone ${l.phone}, que não é de nenhuma conversa`);
  }
});

test('todo contato do cadastro tem contrato, e todo contrato tem pagador e beneficiário', () => {
  const p = plano();
  const contratos = comoObjetos(blocoDe(p, 'service_account'));
  const membros = comoObjetos(blocoDe(p, 'account_member'));
  for (const ct of contratos) {
    const meus = membros.filter((m) => m.account_id === ct.id);
    assert.deepEqual(meus.map((m) => m.bond).sort(), ['beneficiario', 'pagador'],
      `contrato ${ct.servico_label} sem os dois vínculos`);
  }
  // fonte_ausente_em NULL é condição de TODA consulta de renovação: preenchido, o contrato
  // desaparece das telas sem erro nenhum.
  contratos.forEach((ct) => assert.equal(ct.fonte_ausente_em, null));
});

test('o toque de renovação vai para quem PAGA, não para o paciente', () => {
  const p = plano();
  const toques = comoObjetos(blocoDe(p, 'renovacao_touchpoint'));
  const membros = comoObjetos(blocoDe(p, 'account_member'));
  assert.equal(toques.length, 3, 'o roteiro conta com 3 toques: D-10, D-2 e um já enviado');
  for (const t of toques) {
    const pagador = membros.find((m) => m.account_id === t.account_id && m.bond === 'pagador');
    assert.equal(t.person_id, pagador.person_id,
      `o toque de ${t.aluno_nome} não está endereçado ao pagador do contrato`);
  }
  // E o caso que prova a precedência: o Sr. Otávio é o paciente, a filha Renata é quem recebe.
  const doOtavio = toques.find((t) => t.aluno_nome.startsWith('Otávio'));
  assert.equal(doOtavio.destinatario_nome, 'Renata Bernardes');
  assert.notEqual(doOtavio.phone, '5519990000007');
});

test('due_date é fim_vigencia menos os dias do marco, e os marcos saem certos para a data', () => {
  const p = plano();
  for (const t of comoObjetos(blocoDe(p, 'renovacao_touchpoint'))) {
    const dias = Number(String(t.marco).replace('D-', ''));
    assert.equal(t.due_date, cenario.maisDias(t.fim_vigencia, -dias));
  }
  // O roteiro precisa de um contrato em D-10 e um em D-2 CONTADOS DA DATA DA APRESENTAÇÃO.
  const contratos = comoObjetos(blocoDe(p, 'service_account')).map((c) => c.fim_vigencia);
  assert.ok(contratos.includes(cenario.maisDias(HOJE, 10)), 'falta o contrato em D-10');
  assert.ok(contratos.includes(cenario.maisDias(HOJE, 2)), 'falta o contrato em D-2');
});

test('a aba Renovações terá conversa: quem tem contrato na janela também tem conversa', () => {
  // A régua da aba é: vencimento entre hoje-60 e hoje+15, OU toque nosso, OU rascunho.
  const p = plano();
  const contratos = comoObjetos(blocoDe(p, 'service_account'));
  const naJanela = contratos.filter((c) => c.fim_vigencia <= cenario.maisDias(HOJE, 15)
    && c.fim_vigencia >= cenario.maisDias(HOJE, -60));
  assert.ok(naJanela.length >= 3, `esperava ≥3 contratos na janela da aba, achei ${naJanela.length}`);
});

test('a resposta da IA só existe onde há lead — pending_approvals.lead_id é NOT NULL', () => {
  const p = plano();
  const ids = new Set(comoObjetos(blocoDe(p, 'leads')).map((l) => l.id));
  for (const s of comoObjetos(blocoDe(p, 'pending_approvals'))) {
    assert.ok(ids.has(s.lead_id), 'sugestão da IA apontando para lead que o plano não cria');
  }
  // E o roteiro quer SUGESTÃO esperando aprovação (modo 'semi' é o que a demo mostra).
  const pendentes = comoObjetos(blocoDe(p, 'pending_approvals')).filter((s) => s.status === 'PENDING');
  assert.ok(pendentes.length >= 2, `esperava ≥2 sugestões pendentes, achei ${pendentes.length}`);
});

test('3 conversas ficam com entrada não lida (last_read_at nulo)', () => {
  const naoLidas = comoObjetos(blocoDe(plano(), 'conversations')).filter((c) => c.last_read_at === null);
  assert.equal(naoLidas.length, 3);
});

test('nenhum texto do cenário usa nome de recepcionista — quando há nome, é a Janis', () => {
  // Regra do projeto: nenhum texto que alcança o cliente usa Késsia/Rafaela. A trava de saída já
  // barra "aqui é a <recepcionista>"; aqui o cenário não dá o que barrar.
  const p = plano();
  const tudo = JSON.stringify(p);
  for (const proibido of ['Késsia', 'Kessia', 'Rafaela']) {
    assert.ok(!tudo.includes(proibido), `o cenário menciona ${proibido}`);
  }
  assert.ok(tudo.includes('Janis'), 'a assistente precisa se apresentar em algum ponto');
});

test('as datas são montadas no fuso de São Paulo, não no da máquina de quem roda', () => {
  assert.equal(cenario.FUSO, '-03:00');
  assert.equal(cenario.instante('2026-11-04', 0, '09:12'), '2026-11-04T09:12:00-03:00');
  assert.equal(cenario.instante('2026-11-04', 5, '09:12'), '2026-10-30T09:12:00-03:00');
  assert.equal(cenario.maisDias('2026-02-28', 1), '2026-03-01');   // 2026 não é bissexto
  assert.throws(() => cenario.maisDias('04/11/2026', 0), /precisa ser 'YYYY-MM-DD'/);
  assert.throws(() => cenario.instante('2026-11-04', 0, '9:12'), /precisa ser 'HH:MM'/);
});

test('tabelasDoPlano é a ÚNICA lista, e sai do plano', () => {
  const p = plano();
  const tabelas = cenario.tabelasDoPlano(p);
  assert.equal(tabelas.length, new Set(tabelas).size, 'sem repetição');
  assert.deepEqual(tabelas, [...new Set(p.map((b) => b.tabela))]);
  assert.throws(() => cenario.tabelasDoPlano([]), /plano vazio/);
  // Todo bloco tem tenant_id (é a coluna do portão) — menos os marcados portao:false.
  for (const b of p) assert.ok(b.colunas.includes('tenant_id'), `${b.tabela} sem tenant_id`);
});

test('o plano do PROVISIONAMENTO também é plano — nenhuma tabela escrita fora de conferência', () => {
  // A primeira versão do script escrevia estas quatro tabelas à mão, fora do plano: quatro
  // tabelas gravadas sem conferência nenhuma. É o mesmo furo de 31/10/2026, um nível acima.
  const p = demo.planoProvisionamento({
    tenantId: TENANT, hoje: HOJE, slug: 'clinica-exemplo',
    maisDias: cenario.maisDias, instante: cenario.instante,
  });
  assert.deepEqual(cenario.tabelasDoPlano(p), [
    'lead_manager.tenants', 'lead_manager.tenant_subscriptions',
    'lead_manager.tenant_lead_config', 'lead_manager.automacao_config',
  ]);
  // `tenants` é a única sem portão, e por razão geométrica: é a linha que CRIA o portão.
  const semPortao = p.filter((b) => b.portao === false).map((b) => b.tabela);
  assert.deepEqual(semPortao, ['lead_manager.tenants']);
  for (const b of p.filter((x) => x.portao !== false)) {
    assert.ok(b.colunas.includes('tenant_id'), `${b.tabela} sem a coluna do portão`);
  }
  // E as invariantes aparecem na LINHA que vai para o banco, não só no objeto de decisão.
  const t = p[0];
  const linha = Object.fromEntries(t.colunas.map((c, k) => [c, t.linhas[0][k]]));
  assert.equal(linha.is_demo, true);
  assert.equal(linha.lead_manager_active, false);
  assert.equal(linha.evolution_token_enc, null);
  assert.equal(linha.zapi_token, null);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// E. Vocabulário: o que a assistente da CLÍNICA recebe não é texto de escola de música
//
// Pedido do Leo em 02/11: os exemplos pré-escritos nos campos têm de ser de clínica, não de
// escola de música. O Lead Manager não tem formulário nenhum (é API JSON — as telas são do
// dashboard), então o único texto pré-escrito dele que alcança a demonstração é o PROMPT da
// assistente. Este teste mede esse texto.
//
// ⚠ O que ele NÃO cobre, e está dito aqui para não ser confundido com cobertura: os 4 prompts de
// CLASSIFICAÇÃO de src/gemini.js (TRIAGE_PROMPT:67, _INTERESSES_PROMPT:303, INTENT_PROMPT:859,
// EXTRACT_PROMPT:879) vão direto para generateContent SEM passar pelo adaptador de ramo
// (`_adaptar`), e seguem dizendo "escola de música" em qualquer unidade. Medido em 02/11/2026.
// Eles não rodam nesta demonstração (webhook recusado por tenant inativo, rascunhos pré-escritos),
// mas o defeito existe e é do produto, não da demo — ver docs/demo-mf8-lead-manager.md.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('o prompt da assistente da clínica sai SEM vocabulário de escola de música', () => {
  const { resolveSystemPrompt } = require('../src/templates');
  const cfg = demo.configDaUnidade({ nomeExibido: demo.NOME_DO_TENANT });
  const prompt = resolveSystemPrompt({
    school_name: cfg.school_name,
    system_prompt_override: cfg.system_prompt_override,
    available_instruments: cfg.available_instruments,
    business_hours: cfg.business_hours,
    perfil: demo.perfilDaAssistente(),
  });
  // O mecanismo: `templates.renderDefaultPrompt` escolhe o GENERIC_SYSTEM_PROMPT quando
  // `perfilAssistente.generico()` é verdade — e ela é verdade porque o perfil da demo preenche
  // ramo_atividade. Sem ramo, o template padrão diz "uma escola de música".
  for (const palavra of ['escola de música', 'instrumento', 'aula experimental', 'matrícul',
    'aluno', 'professor', 'violão', 'música', 'curso']) {
    const n = (prompt.match(new RegExp(palavra, 'gi')) || []).length;
    assert.equal(n, 0, `o prompt da clínica diz ${JSON.stringify(palavra)} ${n}x`);
  }
  // E o que ele PRECISA dizer, para não passar por omissão (prompt vazio zeraria tudo acima):
  assert.match(prompt, /uma empresa do ramo "clínica ortopédica"/);
  assert.match(prompt, /SEU NOME: Janis/);
  assert.match(prompt, /ASSUNTOS PROIBIDOS/);
  assert.ok(prompt.length > 1200, `prompt curto demais (${prompt.length} caracteres)`);
});

test('o Lead Manager não tem campo de formulário com exemplo pré-escrito', () => {
  // Medido em 02/11/2026: BASE = 128 arquivos .js em src/; PADRÃO = /placeholder/i; 20 linhas,
  // TODAS sobre rótulo de mídia ([áudio], [imagem], [documento: …]). Nenhuma é exemplo de campo.
  // Este teste trava a afirmação: se alguém adicionar um placeholder de formulário aqui, ele cai
  // e quem o escreveu descobre que precisa decidir o vocabulário por ramo.
  const fs = require('node:fs');
  const path = require('node:path');
  const raiz = path.join(__dirname, '..', 'src');
  const arquivos = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? arquivos(p) : (e.name.endsWith('.js') ? [p] : []);
  });
  const todos = arquivos(raiz);
  assert.ok(todos.length >= 120, `BASE menor que o medido: ${todos.length} arquivos`);
  const MIDIA = /\[(áudio|imagem|vídeo|documento|figurinha|mídia)/i;
  const suspeitas = [];
  for (const f of todos) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((linha, i) => {
      if (!/placeholder/i.test(linha)) return;
      if (MIDIA.test(linha)) return;                       // rótulo de mídia, não exemplo de campo
      // `media.placeholder` é o rótulo de mídia do webhook/staffSamples, só sem o "[…]" na linha.
      if (/\bmedia(\s*&&\s*\(media)?\.placeholder\b/.test(linha)) return;
      if (/placeholderMessage|_placeholderMidia|PLACEHOLDER_MIDIA|Placeholders? \{/i.test(linha)) return;
      if (/^\s*(\/\/|\*)/.test(linha)) return;             // comentário
      suspeitas.push(`${path.relative(raiz, f).replace(/\\/g, '/')}:${i + 1}: ${linha.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(suspeitas, [],
    `placeholder que não é de mídia — decidir o vocabulário por ramo:\n${suspeitas.join('\n')}`);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// F. O KANBAN POR RAMO (decisão do Leo em 02/11: "o kanban precisa ser adaptado para uma
//    clínica médica"). A régua é `src/stages.js` e o catálogo é servido em
//    GET /tenant/:id/leads/kanban — `dashboard/views/stages.js` é ESPELHO de contingência.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const stages = require('../src/stages');

// ⭐ Os SEIS textos de hoje, escritos à mão de propósito. É este teste que protege a ADR Valinhos:
// se alguém mudar o default, ele cai. Derivar esta lista do próprio código faria o teste
// concordar com qualquer mudança — seria um espelho, não uma trava.
const COLUNAS_DE_HOJE = [
  { key: 'novo', status: 'NEW', emoji: '🆕', label: 'Novo', dica: 'Novos leads aparecerão aqui' },
  { key: 'qualificando', status: 'QUALIFYING', emoji: '🔍', label: 'Qualificando', dica: 'Leads em conversa ativa' },
  { key: 'qualificado', status: 'QUALIFIED', emoji: '✅', label: 'Qualificado', dica: null },
  { key: 'experimental', status: 'EXPERIMENTAL_AGENDADA', emoji: '🎯', label: 'Experimental', dica: 'Aula experimental agendada' },
  { key: 'convertido', status: 'CONVERTED', emoji: '🎓', label: 'Matriculado', dica: null },
  { key: 'perdido', status: 'PERDIDO', emoji: '❌', label: 'Perdido', dica: null },
];
const resumoDoCatalogo = (perfil) => stages.stageCatalog(perfil).stages
  .map((s) => ({ key: s.key, status: s.status, emoji: s.emoji, label: s.label, dica: s.dica }));

test('⭐ SEM ramo, o catálogo é o de HOJE byte a byte — é isto que protege a ADR Valinhos', () => {
  // Medido em produção em 02/11/2026: `automacao_config.ramo_atividade` da ADR Valinhos está
  // VAZIO. Então ela cai aqui, e aqui nada mudou.
  for (const perfil of [undefined, null, {}, { ramo_atividade: '' }, { ramo_atividade: '   ' }]) {
    assert.deepEqual(resumoDoCatalogo(perfil), COLUNAS_DE_HOJE,
      `o default mudou para perfil ${JSON.stringify(perfil)}`);
  }
  assert.equal(stages.stageCatalog().ramo_rotulo, null);
});

test('ramo de escola também cai no default — o guarda-chuva de ensino vence', () => {
  for (const r of ['escola de música', 'Escola de Música e Artes', 'aula de violão',
    'escola de música para terapeutas']) {
    assert.equal(stages.ramoDoRotulo({ ramo_atividade: r }), null, `${r} não deveria virar saúde`);
    assert.deepEqual(resumoDoCatalogo({ ramo_atividade: r }), COLUNAS_DE_HOJE);
  }
});

test('ramo de clínica troca SÓ os dois rótulos de escola, e nada mais', () => {
  const clinica = resumoDoCatalogo({ ramo_atividade: 'clínica ortopédica' });
  assert.equal(stages.stageCatalog({ ramo_atividade: 'clínica ortopédica' }).ramo_rotulo, 'saude');
  // os dois que mudam
  assert.deepEqual(clinica.find((s) => s.key === 'experimental'),
    { key: 'experimental', status: 'EXPERIMENTAL_AGENDADA', emoji: '🩺', label: 'Avaliação', dica: 'Consulta de avaliação agendada' });
  assert.deepEqual(clinica.find((s) => s.key === 'convertido'),
    { key: 'convertido', status: 'CONVERTED', emoji: '🩺', label: 'Em tratamento', dica: null });
  // os outros QUATRO ficam idênticos ao default
  for (const k of ['novo', 'qualificando', 'qualificado', 'perdido']) {
    assert.deepEqual(clinica.find((s) => s.key === k), COLUNAS_DE_HOJE.find((s) => s.key === k),
      `a coluna ${k} mudou e não devia`);
  }
  // e nenhum rótulo de escola sobra na tela da clínica
  const texto = clinica.map((s) => `${s.label} ${s.dica || ''}`).join(' ');
  for (const p of ['Experimental', 'Matriculado', 'aula', 'Aula', 'escola']) {
    assert.ok(!texto.includes(p), `o kanban da clínica ainda diz ${JSON.stringify(p)}`);
  }
});

test('a CHAVE e o STATUS não mudam com o ramo — é o que mover-kanban espera', () => {
  // Trocar a chave mexeria em `leads.status` já gravado, nas transições e no de-para do arraste.
  const chaves = (p) => stages.stageCatalog(p).stages.map((s) => `${s.key}:${s.status}`);
  assert.deepEqual(chaves({ ramo_atividade: 'clínica ortopédica' }), chaves(null));
  // e o resto do catálogo (transições, de-para, motivos de perda) é o mesmo objeto de sempre
  const a = stages.stageCatalog({ ramo_atividade: 'clínica' });
  const b = stages.stageCatalog(null);
  assert.deepEqual(a.transicoes, b.transicoes);
  assert.deepEqual(a.key_to_status, b.key_to_status);
  assert.deepEqual(a.motivos_perda, b.motivos_perda);
});

test('o ramo descreve o que a empresa FAZ, não quem ela atende', () => {
  // ⚠ Este caso é o ramo da própria empresa a quem a demonstração de 04/11 é feita. Sem o
  // guarda-chuva, ela veria "Avaliação" e "Em tratamento" — e os clientes dela são empresas.
  assert.equal(stages.ramoDoRotulo({ ramo_atividade: 'consultoria tributária para empresas médicas' }), null);
  assert.equal(stages.ramoDoRotulo({ ramo_atividade: 'consultoria tributária' }), null);
  assert.equal(stages.ramoDoRotulo({ ramo_atividade: 'assessoria contábil para clínicas' }), null);
  assert.equal(stages.ramoDoRotulo({ ramo_atividade: 'software para consultórios médicos' }), null);
  // e o que é atendimento a paciente de verdade continua casando
  for (const r of ['clínica ortopédica', 'consultório odontológico', 'Clinica de Fisioterapia',
    'laboratório de análises clínicas', 'clínica de reabilitação']) {
    assert.equal(stages.ramoDoRotulo({ ramo_atividade: r }), 'saude', `${r} deveria ser saúde`);
  }
  // ramo que não é nem um nem outro: default, que é sempre o seguro
  for (const r of ['pet shop', 'academia de ginástica', 'estúdio de tatuagem']) {
    assert.equal(stages.ramoDoRotulo({ ramo_atividade: r }), null);
  }
});

test('o catálogo diz QUAL conjunto aplicou — senão "por que está escrito Avaliação?" só se responde lendo código', () => {
  assert.equal(stages.stageCatalog({ ramo_atividade: 'clínica ortopédica' }).ramo_rotulo, 'saude');
  assert.equal(stages.stageCatalog({ ramo_atividade: 'escola de música' }).ramo_rotulo, null);
  assert.equal(stages.stageCatalog().ramo_rotulo, null);
});

test('a unidade de demonstração cai no conjunto de saúde — pelo perfil que o seed grava', () => {
  // A ligação que importa: o ramo que `tenant-demo.perfilDaAssistente()` grava é o MESMO que o
  // catálogo lê. Se alguém mudar o texto do ramo da demo, este teste diz que o kanban mudou junto.
  const perfil = demo.perfilDaAssistente();
  assert.equal(stages.ramoDoRotulo(perfil), 'saude');
  const c = resumoDoCatalogo(perfil);
  assert.equal(c.find((s) => s.key === 'experimental').label, 'Avaliação');
  assert.equal(c.find((s) => s.key === 'convertido').label, 'Em tratamento');
});

test('o resumo conta linhas de verdade, e o cenário tem tamanho de roteiro de 10 minutos', () => {
  const r = cenario.resumo({ tenantId: TENANT, hoje: HOJE });
  assert.equal(r.tabelas, 10);
  assert.equal(r.linhas, Object.values(r.porTabela).reduce((a, b) => a + b, 0));
  assert.equal(r.porTabela['lead_manager.conversations'], 12);
  assert.ok(r.linhas > 90 && r.linhas < 200, `${r.linhas} linhas — nem vazio nem base de produção`);
});
