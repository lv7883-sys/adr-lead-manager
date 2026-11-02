'use strict';
//
// Colunas do kanban POR UNIDADE (migr 188): renomear, esconder, acrescentar. Testes PUROS.
//
// Pedido do Leo em 02/11/2026, reafirmado depois de eu recomendar o contrário. O que mudou com a
// reafirmação não foi a lista de riscos — foi a pergunta: de "vale a pena?" para "como fazer sem
// quebrar". Estes testes são a resposta.
//
// ⭐ O INVARIANTE QUE SUSTENTA TUDO: coluna extra é VISTA, não ESTADO. Se ela virasse um valor de
// `leads.status`, cairia em 'qualificando' pelo `ELSE` da partição canônica — e o lead seria
// contado DUAS vezes, na coluna extra do quadro e como qualificando no funil inteiro. Medido em
// src/stages.js (stageKey e stageSql terminam os dois assim).
//
const { test } = require('node:test');
const assert = require('node:assert/strict');
const stages = require('../src/stages');
const stagesUi = require('../src/stagesUi');

const K = stages.KANBAN_KEYS;
const CLINICA = { ramo_atividade: 'clínica ortopédica' };
const rotulos = (cat) => cat.stages.map((s) => s.label);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A. O invariante: status desconhecido cai em 'qualificando' — é por isso que a coluna extra NÃO
//    pode morar em `leads.status`. O teste MEDE isso em vez de confiar no comentário.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('⭐ status desconhecido cai em "qualificando" por eliminação — nas DUAS pontas', () => {
  // Se este teste um dia falhar porque alguém deu um destino melhor ao desconhecido, a decisão
  // de onde a coluna extra mora deve ser reavaliada. É a medição que sustenta o desenho inteiro.
  assert.equal(stages.stageOfLead({ status: 'x_triagem' }), 'qualificando');
  assert.equal(stages.stageOfLead({ status: 'INVENTADO' }), 'qualificando');
  assert.match(stages.stageSql('l'), /ELSE 'qualificando' END/);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B. O default. Esta é a metade que protege quem não configurou nada — ou seja, todo mundo hoje.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('⭐ sem configuração, o quadro é o de HOJE — e vale para os dois ramos', () => {
  for (const cfg of [undefined, null, {}, { rotulos: {}, ocultas: [], extras: [] }, 'lixo', 42, []]) {
    assert.deepEqual(rotulos(stages.stageCatalog(null, cfg)),
      ['Novo', 'Qualificando', 'Qualificado', 'Experimental', 'Matriculado', 'Perdido'],
      `config ${JSON.stringify(cfg)} mudou o quadro da unidade de escola`);
    assert.deepEqual(rotulos(stages.stageCatalog(CLINICA, cfg)),
      ['Novo', 'Qualificando', 'Qualificado', 'Avaliação', 'Em tratamento', 'Perdido']);
  }
  assert.deepEqual(stages.stageCatalog().extras, []);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// C. As quatro recusas, e o que cada uma evita
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('coluna extra PRECISA do prefixo — senão colidiria com uma chave da régua', () => {
  assert.equal(stagesUi.validarConfig({ extras: [{ key: 'convertido', label: 'X' }] }, K).erro, 'chave_invalida');
  assert.equal(stagesUi.validarConfig({ extras: [{ key: 'triagem', label: 'X' }] }, K).erro, 'chave_invalida');
  // acento e espaço na chave também saem: ela vai para a URL e para o JSON
  assert.equal(stagesUi.validarConfig({ extras: [{ key: 'x_triagém', label: 'X' }] }, K).erro, 'chave_invalida');
  assert.equal(stagesUi.validarConfig({ extras: [{ key: 'x_', label: 'X' }] }, K).erro, 'chave_invalida');
  assert.equal(stagesUi.validarConfig({ extras: [{ key: 'x_triagem', label: 'X' }] }, K).ok, true);
});

test('⭐ NÃO dá para esconder a coluna de entrada — lead novo nasce nela', () => {
  const r = stagesUi.validarConfig({ ocultas: ['novo'] }, K);
  assert.equal(r.erro, 'coluna_obrigatoria');
  assert.match(r.detalhe, /todo lead novo nasce/);
  // e a régua confirma por que: 'novo' é a coluna marcada como intake
  assert.equal(stages.KANBAN_STAGES.find((s) => s.key === 'novo').auto, true);
});

test('⭐ esconder ESCONDE mesmo — o catálogo não devolve a coluna', () => {
  // ⚠ ESTE TESTE NASCEU DE UM BURACO QUE A SABOTAGEM ACHOU. Os meus testes verificavam que o
  // validador ACEITAVA esconder, e nenhum verificava que a coluna sumia de fato do catálogo.
  // Sabotando `aplicarConfig` para ignorar as ocultas, a suíte seguia VERDE: eu testava a
  // permissão e não o efeito. É a forma do dia — a conferência olhando a decisão, não o
  // resultado dela.
  const v = stagesUi.validarConfig({ ocultas: ['experimental'] }, K);
  const cat = stages.stageCatalog(CLINICA, v.config);
  assert.ok(!cat.stages.some((s) => s.key === 'experimental'), 'a coluna escondida continua no catálogo');
  assert.deepEqual(rotulos(cat), ['Novo', 'Qualificando', 'Qualificado', 'Em tratamento', 'Perdido']);
  // e esconder uma coluna EXTRA também funciona
  const v2 = stagesUi.validarConfig({ extras: [{ key: 'x_a', label: 'A' }], ocultas: ['x_a'] }, K);
  assert.ok(!stages.stageCatalog(null, v2.config).stages.some((s) => s.key === 'x_a'));
});

test('⭐ NÃO dá para esconder coluna COM card — esconder coluna cheia é esconder lead', () => {
  assert.equal(stagesUi.validarConfig({ ocultas: ['qualificado'] }, K, { qualificado: 3 }).erro, 'coluna_com_card');
  assert.equal(stagesUi.validarConfig({ ocultas: ['qualificado'] }, K, { qualificado: 0 }).ok, true);
  // ⚠ E o contrato é explícito: SEM a contagem, esta regra não é conferida. O validador não finge.
  assert.equal(stagesUi.validarConfig({ ocultas: ['qualificado'] }, K).ok, true);
});

test('teto de colunas extras, e nada de esconder o quadro inteiro', () => {
  const muitas = Array.from({ length: stagesUi.MAX_EXTRAS + 1 }, (_, i) => ({ key: `x_${i}`, label: `C${i}` }));
  assert.equal(stagesUi.validarConfig({ extras: muitas }, K).erro, 'extras_demais');
  assert.equal(stagesUi.validarConfig({ extras: muitas.slice(0, stagesUi.MAX_EXTRAS) }, K).ok, true);
  assert.equal(stagesUi.validarConfig({ ocultas: K.filter((k) => k !== 'novo') }, K).ok, true); // sobra 'novo'
});

test('renomear/esconder/posicionar o que não existe é RECUSADO, não ignorado', () => {
  assert.equal(stagesUi.validarConfig({ rotulos: { zzz: { label: 'X' } } }, K).erro, 'coluna_inexistente');
  assert.equal(stagesUi.validarConfig({ ocultas: ['zzz'] }, K).erro, 'coluna_inexistente');
  assert.equal(stagesUi.validarConfig({ extras: [{ key: 'x_a', label: 'A', depois: 'zzz' }] }, K).erro, 'posicao_invalida');
  // Ignorar em silêncio seria pior: a pessoa configuraria, salvaria, e nada mudaria na tela.
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// D. O que a configuração faz quando é válida
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('a coluna extra entra na POSIÇÃO pedida, e sem status', () => {
  const v = stagesUi.validarConfig({ extras: [{ key: 'x_triagem', label: 'Triagem', depois: 'novo' }] }, K);
  const cat = stages.stageCatalog(CLINICA, v.config);
  assert.deepEqual(rotulos(cat),
    ['Novo', 'Triagem', 'Qualificando', 'Qualificado', 'Avaliação', 'Em tratamento', 'Perdido']);
  const extra = cat.stages.find((s) => s.key === 'x_triagem');
  // ⭐ sem status: ela NÃO é um estado do ciclo de vida, e é isso que mantém o funil intacto
  assert.equal(extra.status, null);
  assert.equal(extra.auto, false);           // lead novo não nasce numa coluna criada pela unidade
  assert.equal(extra.requerMotivo, false);
  assert.equal(extra.extra, true);
  assert.deepEqual(cat.extras, ['x_triagem']);
  // sem posição, vai para o fim
  const semPos = stagesUi.validarConfig({ extras: [{ key: 'x_fim', label: 'Fim' }] }, K);
  assert.equal(rotulos(stages.stageCatalog(null, semPos.config)).at(-1), 'Fim');
});

test('renomear não mexe na CHAVE nem no STATUS — é o que mover-kanban espera', () => {
  const v = stagesUi.validarConfig({ rotulos: { convertido: { label: 'Fechado', emoji: '$' } } }, K);
  const comCfg = stages.stageCatalog(null, v.config).stages;
  const semCfg = stages.stageCatalog(null).stages;
  assert.deepEqual(comCfg.map((s) => `${s.key}:${s.status}`), semCfg.map((s) => `${s.key}:${s.status}`));
  assert.equal(comCfg.find((s) => s.key === 'convertido').label, 'Fechado');
  assert.equal(comCfg.find((s) => s.key === 'convertido').emoji, '$');
  // o de-para e as transições do catálogo não mudam
  const a = stages.stageCatalog(null, v.config);
  assert.deepEqual(a.key_to_status, semCfg && stages.stageCatalog(null).key_to_status);
  assert.deepEqual(a.motivos_perda, stages.stageCatalog(null).motivos_perda);
});

test('dica vazia APAGA a dica herdada — por isso o teste é de presença, não de valor', () => {
  const v = stagesUi.validarConfig({ rotulos: { novo: { dica: '' } } }, K);
  assert.equal(stages.stageCatalog(null, v.config).stages.find((s) => s.key === 'novo').dica, null);
  // e sem a chave, a dica da régua continua
  const v2 = stagesUi.validarConfig({ rotulos: { novo: { label: 'Entrada' } } }, K);
  assert.equal(stages.stageCatalog(null, v2.config).stages.find((s) => s.key === 'novo').dica,
    'Novos leads aparecerão aqui');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// E. O vocabulário da tela que não é nome de coluna (o print do Leo, 02/11)
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('o catálogo serve o rótulo do FILTRO — o "Todos os instrumentos" do print', () => {
  // Medido: era UMA string visível, em views/recep-kanban.js:118 do outro repositório. Servir
  // daqui evita que o conserto seja palavra por palavra na tela, e que ele se perca no próximo
  // ramo. O campo filtrado é `lead_qualifications.instrument` — "o que a pessoa procura".
  assert.equal(stages.stageCatalog().rotulos.filtro_interesse, 'Todos os instrumentos');
  assert.equal(stages.stageCatalog(CLINICA).rotulos.filtro_interesse, 'Todas as especialidades');
  assert.equal(stages.stageCatalog({ ramo_atividade: 'escola de música' }).rotulos.filtro_interesse,
    'Todos os instrumentos');
  // ramo que não é nem um nem outro cai no default, como o rótulo das colunas
  assert.equal(stages.stageCatalog({ ramo_atividade: 'pet shop' }).rotulos.filtro_interesse,
    'Todos os instrumentos');
});
