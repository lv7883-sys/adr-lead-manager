'use strict';

// Aviso de lead novo no aparelho (popup + número no ícone) — pedido do Leo, 16/11/2026.
// Teste PURO, sem banco. Ver docs/proposta-aviso-lead-novo.md (D1 e D2).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const aviso = require('../src/avisoDispositivo');
const semAtendimento = require('../src/semAtendimentoHumano');
const { FONTES_HUMANAS } = require('../src/staffSamples');

test('a tag é a MESMA nos dois tempos — é o que faz um aviso em vez de dois', () => {
  // O desenho inteiro do aviso em dois tempos depende disto: o 2º push substitui o 1º na tela
  // porque carregam a mesma tag. Se a tag divergir, a pessoa recebe DOIS avisos do mesmo lead —
  // um dizendo "contato novo, •••• 4321" e outro "lead novo, Mariana" — e some a vantagem toda.
  //
  // E a tag deriva do CONTATO, nunca do lead: no 1º tempo o lead ainda não existe.
  // As duas pontas NÃO recebem a mesma string: o 1º tempo manda o jid cru (como o WhatsApp
  // entrega) e o 2º manda o telefone como foi gravado. Todas estas formas do MESMO número têm de
  // produzir a mesma tag — inclusive a diferença do 9º dígito, que é a que de fato acontece.
  const formas = [
    '5519987654321',          // jid, como chega no webhook
    '+55 (19) 98765-4321',    // formatado
    '551987654321',           // sem o 9º dígito (o mesmo assinante: 9 8765-4321 → 8765-4321)
    '19987654321',            // sem o 55
  ];
  const tags = new Set(formas.map(aviso.tagDoContato));
  assert.equal(tags.size, 1, `tag divergiu entre formas do mesmo número: ${[...tags].join(' / ')}`);
  const tag = [...tags][0];
  assert.match(tag, /^lead-[0-9A-Za-z_]+$/, 'a tag não pode ter caractere que o navegador recuse');
  // Números DIFERENTES não podem colidir: tag igual faria o aviso de um lead apagar o do outro.
  assert.notEqual(aviso.tagDoContato('5519987654321'), aviso.tagDoContato('5519912345678'));
});

test('sem telefone a tag não explode nem colide com um contato real', () => {
  assert.equal(aviso.tagDoContato(null), 'lead-desconhecido');
  assert.equal(aviso.tagDoContato(''), 'lead-desconhecido');
});

test('o aviso na tela de bloqueio mostra 4 dígitos, não o telefone inteiro', () => {
  // Um aviso de push aparece na tela de bloqueio, onde qualquer um que passe perto vê. No 1º
  // tempo o telefone é a única identificação que existe, então ele aparece — mas o mínimo.
  assert.equal(aviso._telefoneDiscreto('5519987654321'), '•••• 4321');
  assert.equal(aviso._telefoneDiscreto('+55 19 98765-4321'), '•••• 4321');
  // Sem dígito suficiente, não inventa nem vaza o que veio.
  assert.equal(aviso._telefoneDiscreto('abc'), 'número novo');
  assert.equal(aviso._telefoneDiscreto(null), 'número novo');
  assert.equal(aviso._telefoneDiscreto('12'), 'número novo');
});

test('a contagem do ícone NÃO passa pelo veredito da IA — não é a régua da bola', () => {
  // ESTA É A TRAVA MAIS IMPORTANTE DESTE ARQUIVO, e ela guarda uma decisão que já quase foi
  // tomada errada. A tentação era reaproveitar src/bola.js passando "última saída humana" no
  // lugar de "última saída". Não funciona: a régua da bola consulta `conversation_state` antes
  // das saídas, e quando a Janis responde o motor grava AGUARDANDO_CLIENTE — veredito que vence
  // a conta e tira o lead do número de qualquer jeito.
  //
  // Se alguém "simplificar" este arquivo usando bola.js, o número do ícone volta a zerar sozinho
  // quando a Janis responde — exatamente o que o Leo decidiu que NÃO deve acontecer (D1) — e sem
  // nenhum erro aparecendo em lugar nenhum.
  assert.doesNotMatch(semAtendimento.CONTAGEM_SQL, /conversation_state/,
    'a contagem de "ninguém olhou" voltou a depender do veredito da IA — leia o cabeçalho do módulo');
  assert.doesNotMatch(semAtendimento.CONTAGEM_SQL, /state_computed_at/);
  const bola = fs.readFileSync(path.join(__dirname, '..', 'src', 'semAtendimentoHumano.js'), 'utf8');
  assert.doesNotMatch(bola, /require\(['"]\.\/bola['"]\)/, 'este módulo não importa a régua da bola');
});

test('a contagem exclui lead morto com as MESMAS exclusões do awaiting_reply', () => {
  // Reaproveitar o que é de fato comum (sem copiar régua): lead convertido, com aula agendada ou
  // com desfecho não pode ficar pendurado no ícone para sempre.
  for (const pedaco of ["l.status <> 'CONVERTED'", "l.status <> 'EXPERIMENTAL_AGENDADA'", 'l.desfecho IS NULL']) {
    assert.ok(semAtendimento.CONTAGEM_SQL.includes(pedaco), `falta a exclusão: ${pedaco}`);
  }
});

test('reação não conta como o cliente ter falado', () => {
  // Um 👍 não é a pessoa pedindo informação. Já custou caro neste projeto (a fila dizia
  // "responder agora" em lead respondido), e a régua é única: naoEhReacaoSql.
  assert.match(semAtendimento.CONTAGEM_SQL, /NOT LIKE/, 'a contagem tem de descontar reação');
});

test('"respondeu" inclui a recepcionista digitando no WhatsApp dela, não só o painel', () => {
  // Se só contasse source='api' (o painel), o lead atendido pelo celular da recepcionista ficaria
  // no ícone para sempre — e ela juraria ter respondido, com razão.
  assert.match(semAtendimento.SAIDA_CONTA_SQL, /s\.source = ANY\(\$3::text\[\]\)/);
  // E a lista de fontes humanas é IMPORTADA, não recopiada: é a mesma de quem já grava a saída.
  assert.ok(FONTES_HUMANAS.has('web') && FONTES_HUMANAS.has('android')
    && FONTES_HUMANAS.has('ios') && FONTES_HUMANAS.has('desktop'));
  assert.ok(!FONTES_HUMANAS.has('api'), "'api' não é humano por si: quem distingue é a autoria");
});

test('autoria vem da COLUNA, não do nome — trocar o nome da IA não reescreve o passado', () => {
  // ESTE É O DEFEITO QUE A REVISÃO INDEPENDENTE MEDIU em 18/11/2026, e o motivo da migr 193.
  // A regra antiga era "sender diferente do nome_ia ATUAL". Em produção isso fazia:
  //   • 'Janis J.' (26), 'Janis Joplin' (6), 'Janis' (5) — nomes ANTIGOS da assistente — contarem
  //     como atendimento HUMANO, porque não casavam com o nome de hoje;
  //   • 'SERVICE' (3.581) contar como pessoa, sendo o PAPEL DO TOKEN e não autoria.
  // Renomear a Janis na tela reescrevia o passado: 37 respostas dela viravam "a recepção
  // atendeu". Nenhum erro aparecia — o número ficava plausível e errado.
  assert.match(semAtendimento.SAIDA_CONTA_SQL, /s\.autor_tipo = 'humano'/,
    'a autoria declarada na escrita tem de ser o caminho principal');
  // O fallback do passado existe, mas só para linha SEM autoria declarada — nunca por cima dela.
  assert.match(semAtendimento.SAIDA_CONTA_SQL, /s\.autor_tipo IS NULL/);
  assert.match(semAtendimento.SAIDA_CONTA_SQL, /'boas-vindas-auto', 'renovacao-auto'/,
    'automação conhecida não conta como pessoa nem no fallback');
});

test('o modo é configurável por unidade, e o padrão é o conservador', () => {
  // Pedido do Leo em 18/11/2026: "configurável para o caso de um dia termos a agente de IA
  // respondendo os leads interinamente".
  assert.deepEqual(semAtendimento.MODOS, ['humano', 'humano_ou_ia']);
  // No modo 'humano_ou_ia' QUALQUER saída nossa conta — é a cláusula que liga o atalho.
  assert.match(semAtendimento.SAIDA_CONTA_SQL, /\$4 = 'humano_ou_ia'/);
  // ⚠ E o padrão tem de ser 'humano': deixar o lead NO ícone erra para o lado de pedir atenção.
  //   O erro contrário — assumir 'humano_ou_ia' por default — é silencioso: leads desapareceriam
  //   do ícone sem ninguém ter olhado, que é exatamente o que a decisão D1 proíbe.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'semAtendimentoHumano.js'), 'utf8');
  assert.match(src, /let modo = 'humano';/, "o default do modo tem de ser 'humano'");
});

test('quem escreve DECLARA a autoria — os quatro caminhos de saída', () => {
  // Sem isto, a coluna nasce vazia e a régua cai no fallback para sempre. Cada caminho declara:
  const ler = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
  assert.match(ler('autoReply.js'), /autorTipo: 'ia'/, 'a Janis declara que é IA');
  assert.match(ler('jobs/renovacao-sweep.js'), /autorTipo: 'automacao'/, 'renovação declara automação');
  assert.match(ler('boasVindas/auto.js'), /autorTipo: 'automacao'/, 'boas-vindas declara automação');
  // O painel do Regente: default 'humano' nos dois atalhos de envio do inbox.
  assert.match(ler('routes/inbox.js'), /autorTipo = 'humano'/, 'o painel declara humano');
  // E o registrador só aceita os três valores — palpite não entra no banco.
  assert.match(ler('outbound.js'), /\['ia', 'humano', 'automacao'\]\.includes\(autorTipo\)/);
});

test('a contagem casa contato pela régua da casa (br_phone_key), não por dígitos crus', () => {
  // Casar "só os dígitos" é o que já cruzou grupo com privado neste projeto (conversa fantasma).
  assert.match(semAtendimento.CONTAGEM_SQL, /br_phone_key/);
});

test('falha da contagem não vira zero — zero diria "está tudo atendido"', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'semAtendimentoHumano.js'), 'utf8');
  // O erro SOBE daqui. Quem chama decide o que fazer; o que não se pode é transformar falha em
  // zero e apagar o aviso da recepção dizendo que não há nada pendente.
  const corpoDaContagem = src.slice(src.indexOf('async function contar'));
  assert.doesNotMatch(corpoDaContagem.slice(0, 600), /catch/,
    'contar() ganhou um catch: confirme que ele não devolve 0 em caso de falha');
});
