'use strict';
// linkPreview.js — o link vira "caixinha" (prévia com título/imagem) no WhatsApp de quem recebe.
//
// A prévia é gerada no envio pela Evolution/Baileys, mas SÓ para endereço que começa com https:// (URL_REGEX do
// Baileys). A recepção costuma colar "www.site.com.br/pagar" ou "mpago.la/abc": o WhatsApp deixa clicável, mas
// sem caixinha. Aqui o PRIMEIRO link sem esquema ganha "https://" (a prévia do WhatsApp é sempre do 1º link).
// Não mexe em texto que já tem https://, em e-mail, nem em http:// (site só-http quebraria).

const TLD = '(?:com|net|org|br|app|io|me|link|la|ly|gl|co|online|site|store|shop|pay|edu|gov|info|biz|dev|page|club|art|music)';
const RE = new RegExp(`(^|[\\s(\\[<"'])((?:www\\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\\.${TLD}(?:\\.[a-z]{2})?(?:\\/[^\\s<>"']*)?)(?=$|[\\s)\\]>"',.!?;:])`, 'i');

function comEsquema(texto) {
  const t = String(texto == null ? '' : texto);
  if (/https:\/\//i.test(t)) return t;
  const m = t.match(RE);
  if (!m) return t;
  const antes = t.slice(0, m.index);
  if (/https?:\/\/$/i.test(antes + m[1])) return t;
  return antes + m[1] + 'https://' + m[2] + t.slice(m.index + m[0].length);
}

module.exports = { comEsquema };
