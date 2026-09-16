-- ============================================================
-- 125 — BOAS-VINDAS (ADR-050, E17-01): SEED do primeiro modelo — "Escola de música — Academia do Rock".
--
-- Fonte: planilha "Plano de Boas-vindas.xlsx" (OneDrive Gerencial/Recepção), aba 1, e decisões do dono
-- de 2026-09-16 (etapa 5 = Guia do Aluno; etapa 6 = imagem de projetos e eventos; anexo em toda etapa;
-- contrato curto roda 1, 2, 4 e 5).
--
-- Conversão da planilha para o vocabulário neutro do motor:
--   [nome] (aluno) → {cliente}    [responsável] → {responsavel}    professor [nome] → {profissional}
--   Instrumento → {servico}       [dia tal] → {dia}                [horário] → {horario}
--   "Academia do Rock de Valinhos" → {empresa}      link do EAD → {link_ead} (variável livre da unidade)
--   link da pesquisa → {link_pesquisa} (variável livre; só usada por quem não tem o Diapasão)
-- Ajustes de forma, sem mudar o conteúdo: negrito do WhatsApp da 1ª linha da etapa 1 (a planilha tinha
-- "* [nome]…", que não fica em negrito), "Gostaríamos saber" → "Gostaríamos de saber" (etapa 4), espaço
-- antes de vírgula (etapa 3), "do [nome]"/"ele" → "do(a) {cliente}"/"ele(a)" como a própria planilha faz
-- na etapa 7; etapa 2: "reposições  podem ser tratados" → "reposições pode ser tratada" (concordância),
-- espaço depois do 📌 e ponto e vírgula uniforme na lista.
--
-- ⚠ ETAPA 6: a planilha só lista os TEMAS (eventos, experiências, projetos), não traz a mensagem pronta.
-- O texto abaixo é RASCUNHO para a gestão revisar na tela de configuração.
--
-- A etapa 7 é entregue_por = 'externo': quem envia é o NPS Pulse do Diapasão (primeiro ponto em
-- ini_vigencia + 30 dias). O Regente só mostra na linha do tempo. O texto fica para unidades sem Diapasão.
--
-- IDEMPOTENTE: ON CONFLICT DO NOTHING — reaplicar não sobrescreve ajuste feito por migration posterior.
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 125_boas_vindas_modelo_escola_musica.sql
-- ROLLBACK:
--   DELETE FROM lead_manager.boas_vindas_modelo WHERE slug = 'escola-de-musica-academia-do-rock';  -- cascade nas etapas
-- ============================================================
BEGIN;

INSERT INTO lead_manager.boas_vindas_modelo (slug, nome, ramo, descricao) VALUES
  ('escola-de-musica-academia-do-rock', 'Escola de música — Academia do Rock', 'Escola de música',
   'Régua de 7 mensagens do plano de boas-vindas da Academia do Rock: da matrícula à pesquisa de satisfação de 30 dias.')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO lead_manager.boas_vindas_modelo_etapa
  (modelo_slug, ordem, nome, ancora, quando, repeticoes, contrato_curto,
   texto_titular, texto_responsavel, anexo_sugerido, anexo_tipo, entregue_por)
VALUES
-- 1 ─ No dia da matrícula ─────────────────────────────────────────────────────────────────────────
('escola-de-musica-academia-do-rock', 1, 'Boas-vindas', 'inicio_contrato', '{"tipo":"dias","valor":0}', 1, true,
$t$*{cliente}, seja muito bem-vindo!* 🎶
*Estamos muito felizes por você fazer parte da {empresa}!*

Deixamos tudo preparado para o início das aulas:

* Instrumento: {servico}
* Professor: {profissional}
* Dia: {dia}
* Horário: {horario}

🎶 Acesse suas aulas de Teoria Musical e Harmonia Básica:
{link_ead}

Em breve vamos enviar algumas orientações importantes para vocês. Qualquer dúvida, estamos por aqui!

LET’S ROCK!
{empresa}$t$,
NULL,
'Imagem mostrando como navegar no link do EAD enviado na mensagem', 'imagem', 'regente'),

-- 2 ─ 2 dias depois ───────────────────────────────────────────────────────────────────────────────
('escola-de-musica-academia-do-rock', 2, 'Orientações iniciais', 'inicio_contrato', '{"tipo":"dias","valor":2}', 1, true,
$t$Queremos que a sua experiência seja a *melhor possível*, e para isso, a comunicação objetiva e transparente é imprescindível.

📌 Algumas orientações importantes para começar:

* Você poderá cancelar e repor sua aula uma vez no mês, com aviso de pelo menos 12h de antecedência;
* O agendamento da aula cancelada deve ser feito dentro de um mês, a partir da data do cancelamento;
* Em caso de falta, a aula será contabilizada como realizada;
* Em caso de atraso, a aula terminará no horário programado;
* Qualquer dúvida sobre horários, faltas e reposições pode ser tratada diretamente com a recepção.

As demais condições estão no seu contrato e, se precisarem consultar alguma informação, estamos à disposição para ajudar. 😊$t$,
NULL, NULL, NULL, 'regente'),

-- 3 ─ Véspera das 2 primeiras aulas ───────────────────────────────────────────────────────────────
('escola-de-musica-academia-do-rock', 3, 'Lembrete da aula', 'atendimento_agendado', '{"tipo":"vespera"}', 2, false,
$t$Oi, {cliente}! 😊 Passando para lembrar que a sua aula será amanhã, {dia}, às {horario}, com o professor {profissional}. 🎸

Estamos esperando você! ❤️$t$,
$t$Oi, {responsavel}! 😊 Passando para lembrar que a aula do(a) {cliente} será amanhã, {dia}, às {horario}, com o professor {profissional}. 🎸

Estamos esperando por ele(a)! ❤️$t$,
NULL, NULL, 'regente'),

-- 4 ─ Depois da 1ª aula ───────────────────────────────────────────────────────────────────────────
('escola-de-musica-academia-do-rock', 4, 'Como foi a primeira aula', 'primeiro_atendimento', '{"tipo":"proximo_expediente"}', 1, true,
$t$Oi, {cliente}! Tudo bem? 😊

Gostaríamos de saber como foi a sua primeira aula! Esperamos que tenha gostado bastante. 🎶

Qualquer dúvida ou se precisar de alguma orientação nesse comecinho, pode contar com a gente!$t$,
$t$Oi, {responsavel}! Tudo bem? 😊

Gostaríamos de saber como foi a primeira aula do(a) {cliente}! Esperamos que ele(a) tenha gostado bastante. 🎶

Qualquer dúvida ou se precisarem de alguma orientação nesse comecinho, podem contar com a gente!$t$,
NULL, NULL, 'regente'),

-- 5 ─ 5 dias depois da 1ª aula ────────────────────────────────────────────────────────────────────
('escola-de-musica-academia-do-rock', 5, 'Guia do Aluno', 'primeiro_atendimento', '{"tipo":"dias","valor":5}', 1, true,
$t$Oi, {cliente}! 😊
Como você está começando agora, queremos deixar à mão algumas informações importantes sobre o funcionamento da escola.

Preparamos um *Guia do Aluno* com as principais orientações sobre aulas, faltas, reposições, comunicação, instrumentos, eventos e outros pontos da nossa rotina. 🎸

Vale a pena deixar salvo para consultar sempre que precisar.

Qualquer dúvida, nossa recepção está à disposição! ❤️$t$,
$t$Oi, {responsavel}! 😊
Como o(a) {cliente} está começando agora, queremos deixar à mão algumas informações importantes sobre o funcionamento da escola.

Preparamos um *Guia do Aluno* com as principais orientações sobre aulas, faltas, reposições, comunicação, instrumentos, eventos e outros pontos da nossa rotina. 🎸

Vale a pena deixar salvo para consultar sempre que precisarem.

Qualquer dúvida, nossa recepção está à disposição! ❤️$t$,
'Imagem do Guia rápido do Aluno: as regras da rotina da escola em uma tela de celular', 'imagem', 'regente'),

-- 6 ─ 25 dias depois da 1ª aula (RASCUNHO — ver cabeçalho) ────────────────────────────────────────
('escola-de-musica-academia-do-rock', 6, 'Projetos e eventos', 'primeiro_atendimento', '{"tipo":"dias","valor":25}', 1, false,
$t$Olá! 🎸

A música na {empresa} vai muito além da sala de aula! Ao longo do ano temos Rock Hour, projetos de banda, Rock Bands, jam sessions, workshops e apresentações.

Na imagem estão os nossos projetos e as próximas datas. Quer participar de algum? É só chamar a recepção! 🎶$t$,
NULL,
'Imagem com os projetos de banda, Rock Bands, Rock Hour e as datas dos eventos', 'imagem', 'regente'),

-- 7 ─ 30 dias da matrícula — ENVIADA PELO DIAPASÃO (NPS Pulse) ────────────────────────────────────
('escola-de-musica-academia-do-rock', 7, 'Pesquisa de satisfação', 'inicio_contrato', '{"tipo":"dias","valor":30}', 1, false,
$t$Oi, {cliente}! 😊 Já faz aproximadamente um mês que você começou com a gente e queríamos saber como está sendo essa experiência.

Poderia nos contar como está sendo a sua experiência por esse link abaixo?

{link_pesquisa}$t$,
$t$Oi, {responsavel}! 😊 Já faz aproximadamente um mês que o(a) {cliente} começou com a gente e queríamos saber como está sendo essa experiência para ele(a).

Poderiam nos contar como está sendo essa experiência por esse link abaixo?

{link_pesquisa}$t$,
NULL, NULL, 'externo')
ON CONFLICT (modelo_slug, ordem) DO NOTHING;

-- Fim de linha: um checkout no Windows (core.autocrlf) grava CRLF dentro dos textos acima; o WhatsApp deve
-- receber só LF. chr(13) = CR. Idempotente.
UPDATE lead_manager.boas_vindas_modelo_etapa
   SET texto_titular = replace(texto_titular, chr(13), ''),
       texto_responsavel = replace(texto_responsavel, chr(13), '')
 WHERE modelo_slug = 'escola-de-musica-academia-do-rock'
   AND (strpos(texto_titular, chr(13)) > 0 OR strpos(coalesce(texto_responsavel, ''), chr(13)) > 0);

COMMIT;
