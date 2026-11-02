#!/usr/bin/env node
'use strict';
//
// sabotagem-demo-mf8.js — prova que `test/demo-mf8.test.js` PEGA o que diz pegar.
//
// ⚠ ESTE SCRIPT EDITA ARQUIVOS DO REPOSITÓRIO e os restaura. Não é teste: é a prova do teste.
//   Por isso mora em scripts/ e não em test/ — ninguém quer isto rodando dentro de `npm test`.
//
// POR QUE ELE EXISTE
//
// Teste verde depois de uma mutação não prova nada até você VER a mutação derrubar o teste. Uma
// suíte com 29 casos verdes e uma invariante não coberta é indistinguível, de fora, de uma suíte
// que cobre tudo. Este script torna a diferença visível: sabota um ponto por vez e EXIGE que a
// suíte caia.
//
// AS DUAS ARMADILHAS QUE ELE EVITA, E É SÓ POR ELAS QUE ELE VALE
//
//   1. Substituição que NÃO APLICA deixa a suíte verde e parecendo prova. Então cada sabotagem
//      afirma que o texto casou EXATAMENTE UMA VEZ (`split(velho).length - 1 === 1`) e aborta
//      quando não casa — em vez de seguir e relatar "✔ caiu" sobre nada.
//   2. Suíte que cai por QUALQUER edição não prova nada tampouco. Por isso existe o caso de
//      CONTROLE no fim da lista: uma mudança inócua que PRECISA deixar a suíte verde.
//
// USO:  node scripts/sabotagem-demo-mf8.js
//       (sai 0 se todas as sabotagens derrubaram a suíte e o controle não)
//
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..');
const SUITES = [path.join(RAIZ, 'test', 'demo-mf8.test.js'), path.join(RAIZ, 'test', 'kanban-colunas.test.js')];

// Guarda: o script restaura os arquivos no fim, mas uma interrupção no meio deixaria um arquivo
// sabotado no disco. Com a árvore limpa, `git status` mostra na hora; com alterações pendentes,
// a sabotagem se esconde no meio delas. Então recusa.
try {
  const sujo = execFileSync('git', ['status', '--porcelain', '--', 'src/demo', 'src/stages.js', 'src/stagesUi.js'], { cwd: RAIZ })
    .toString().trim();
  if (sujo) {
    console.error('RECUSADO: há alterações não commitadas em src/demo ou src/stages.js —\n' + sujo
      + '\n\nEste script EDITA esses arquivos e os restaura. Com a árvore suja, uma interrupção '
      + 'no meio deixaria a sabotagem escondida entre as suas mudanças. Commite antes.');
    process.exit(1);
  }
} catch (e) {
  // Sem git no caminho a guarda não existe — e isso é DITO, não assumido como "está limpo".
  console.warn(`AVISO: não deu para conferir a árvore com git (${e.message}). `
    + 'Se o script for interrompido, confira src/demo/ à mão.');
}

const SABOTAGENS = [
  ['src/demo/tenant-demo.js', 'lead_manager_active: false,', 'lead_manager_active: true,',
    'tenant de demonstração entra nos laços de fundo'],
  ['src/demo/tenant-demo.js', 'is_demo: true,              // (2) o portão do seed',
    'is_demo: false,              // (2) o portão do seed', 'portão is_demo desligado'],
  ['src/demo/tenant-demo.js', 'zapi_token: null,', "zapi_token: 'abc123',", 'credencial de envio preenchida'],
  ['src/demo/tenant-demo.js', 'renovacao_auto_envio: false,', 'renovacao_auto_envio: true,',
    'envio automático de renovação ligado'],
  ['src/demo/tenant-demo.js', "      portao: false,   // ver o cabeçalho desta função",
    "      portao: true,   // ver o cabeçalho desta função",
    'linha que cria o tenant deixa de ser a única sem portão'],
  ['src/demo/cenario-mf8.js', 'pagador: c.contrato.pagadorProprio ? c.chave : c.pagador.chave,',
    'pagador: c.chave,', 'toque de renovação endereçado ao paciente em vez do pagador'],
  ['src/demo/cenario-mf8.js', 'Quer que eu peça para a recepção reservar sua vaga do próximo mês?',
    'A mensalidade segue R$ 320,00 — quer que eu reserve?', 'dinheiro no texto do rascunho'],
  ['src/demo/cenario-mf8.js', "const h = crypto.createHash('sha1').update(`${NAMESPACE}|${tipo}|${chave}`).digest();",
    'const h = crypto.randomBytes(20);', 'uuid sorteado em vez de derivado'],
  ['src/demo/cenario-mf8.js', "c.naoLida ? null : ultima,           // last_read_at",
    "ultima,           // last_read_at", 'nenhuma conversa fica com entrada não lida'],
  // ⭐ A tabela que está no plano e não está no esquema congelado deixa de ser acusada: é
  // exatamente o modo de falha de 31/10/2026 no dashboard — sem conferência e sem aviso.
  ['src/demo/conformidade.js',
    '      problemas.push(\n        `[${nome}] está no PLANO',
    '      if (false) problemas.push(\n        `[${nome}] está no PLANO',
    'tabela sem conferência fica SILENCIOSA'],
  ['src/demo/conformidade.js', '          if (r === false) {', '          if (false) {',
    'CHECK reprovado deixa de virar problema'],
  ['src/demo/check-sql.js',
    '    throw new Error(`check-sql: caractere não suportado ${JSON.stringify(c)} em ${JSON.stringify(src)}`);',
    '    i += 1; continue;', 'caractere desconhecido ignorado em vez de recusado'],
  // Vocabulário (pedido do Leo em 02/11: exemplos de clínica, não de escola de música).
  ['src/demo/tenant-demo.js', "    ramo_atividade: 'clínica ortopédica',", "    ramo_atividade: '',",
    'ramo vazio — o prompt da assistente deixa de dizer de que empresa ela é'],
  ['src/demo/tenant-demo.js', "    nome_ia: 'Janis',",
    "    nome_ia: 'Janis',\n    placeholder_exemplo: 'ex.: violão, guitarra, bateria',",
    'exemplo pré-escrito de escola de música aparece num campo do LM'],
  // Kanban por ramo (decisão do Leo em 02/11). A primeira é a mais importante do arquivo: ela
  // prova que a trava que protege a ADR Valinhos DISPARA.
  ['src/stages.js', "emoji: '🎓', label: 'Matriculado', column: true,",
    "emoji: '🩺', label: 'Em tratamento', column: true,",
    'o DEFAULT foi adaptado em vez de o ramo — a Valinhos veria rótulo de clínica'],
  ['src/stages.js', "    experimental: { label: 'Avaliação', emoji: '🩺', dica: 'Consulta de avaliação agendada' },",
    "    experimental: { label: 'Experimental', emoji: '🎯', dica: 'Aula experimental agendada' },",
    'o rótulo da clínica volta a ser de escola'],
  ['src/stages.js', "  'consultoria', 'assessoria',", "  'assessoria',",
    'quem presta serviço PARA a saúde passa a ver rótulo de paciente'],
  ['src/stages.js', '      key: s.key, status: s.status, emoji: r.emoji, label: r.label,',
    '      key: s.key, status: r.label, emoji: r.emoji, label: r.label,',
    'o status passa a depender do rótulo — mover-kanban quebraria'],
  // Colunas do kanban por unidade (migr 188). A primeira é a que protege quem não configurou nada.
  ['src/stagesUi.js', "const NAO_OCULTAVEIS = Object.freeze(['novo']);",
    'const NAO_OCULTAVEIS = Object.freeze([]);',
    'a coluna de entrada passa a poder ser escondida — lead novo ficaria invisível'],
  ['src/stagesUi.js', "    if (cardsPorColuna && Number(cardsPorColuna[key] || 0) > 0) {",
    '    if (false) {',
    'esconder coluna COM card deixa de ser recusado — esconderia leads'],
  // ⚠ A guarda do prefixo é REDUNDANTE: desligá-la sozinha não muda nada, porque o teste do
  // formato (`/^x_[a-z0-9_]+$/`) logo abaixo recusa a mesma chave. A sabotagem precisa quebrar a
  // EFETIVA, senão ela prova apenas que existe redundância — que é verdade e não é o ponto.
  // Descoberto rodando este próprio script: a primeira versão desta linha deixava a suíte verde.
  ['src/stagesUi.js', "    if (!/^x_[a-z0-9_]+$/.test(key)) {",
    '    if (false) {',
    'coluna extra pode colidir com uma chave da régua'],
  ['src/stagesUi.js', '  const fora = canonicas.filter((c) => !ocultas.has(c.key)).map(comRotulo);',
    '  const fora = canonicas.map(comRotulo);',
    'esconder deixa de esconder — a configuração não faz nada'],
  ['src/stages.js', "  saude: Object.freeze({ filtro_interesse: 'Todas as especialidades', interesse: 'especialidade' }),",
    "  saude: Object.freeze({ filtro_interesse: 'Todos os instrumentos', interesse: 'instrumento' }),",
    'o filtro da clínica volta a dizer "instrumentos"'],
  ['src/demo/check-sql.js', '  if (a === true || b === true) return true;',
    '  if (a === true || b === true) return true;   // (marcador)', '(controle) mudança inócua'],
];

function rodaSuite() {
  try {
    execFileSync(process.execPath, ['--test', '--test-reporter=tap', ...SUITES], { cwd: RAIZ, stdio: 'pipe' });
    return { passou: true };
  } catch (e) {
    return { passou: false, saida: String(e.stdout || '') + String(e.stderr || '') };
  }
}

const antes = rodaSuite();
if (!antes.passou) {
  console.error('A suíte já estava VERMELHA antes de qualquer sabotagem. Nada aqui prova nada.');
  process.exit(1);
}
console.log('base: suíte VERDE\n');

let falhas = 0;
for (const [rel, velho, novo, oQueProva] of SABOTAGENS) {
  const controle = oQueProva.startsWith('(controle)');
  const arq = path.join(RAIZ, rel);
  const original = fs.readFileSync(arq, 'utf8');
  const n = original.split(velho).length - 1;
  if (n !== 1) {
    console.error(`NÃO APLICADA (${n} ocorrências, esperava 1) em ${rel}: ${JSON.stringify(velho.slice(0, 70))}`);
    falhas += 1;
    continue;
  }
  fs.writeFileSync(arq, original.replace(velho, novo), 'utf8');
  const r = rodaSuite();
  fs.writeFileSync(arq, original, 'utf8');
  if (controle) {
    // O controle existe para provar que a suíte não cai por QUALQUER edição — senão "caiu"
    // não significaria nada.
    if (r.passou) console.log(`✔ ${oQueProva}: suíte seguiu verde, como devia`);
    else { console.error(`❌ ${oQueProva} derrubou a suíte — ela está caindo por motivo errado`); falhas += 1; }
    continue;
  }
  if (r.passou) {
    console.error(`❌ SUÍTE SEGUIU VERDE com ${oQueProva} — este ponto NÃO está coberto.`);
    falhas += 1;
  } else {
    const quebrou = (r.saida.match(/^not ok \d+ - (.+)$/gm) || []).map((l) => l.replace(/^not ok \d+ - /, ''));
    console.log(`✔ caiu: ${oQueProva}`);
    console.log(`    derrubou ${quebrou.length}: ${quebrou.slice(0, 2).join(' | ')}`);
  }
}

const depois = rodaSuite();
console.log(`\nrestaurado: suíte ${depois.passou ? 'VERDE' : 'VERMELHA (⚠ restauração falhou)'}`);
if (!depois.passou) falhas += 1;
console.log(falhas ? `\n${falhas} problema(s) na prova de sabotagem.` : '\nTodas as sabotagens derrubaram a suíte, e o controle não.');
process.exit(falhas ? 1 : 0);
