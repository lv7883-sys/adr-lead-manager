'use strict';
//
// telefoneBR.js — normalização BR-aware de telefone para o funil (ingestão).
//
// Porta do canônico do dashboard (`dashboard/lib/telefone.js`, lista ANATEL) + da
// lógica de 9º dígito do envio (`evolution.js:_toggle9BR`), unificados num só lugar
// no LM (containers separados não compartilham require entre repos).
//
//   digitsBR(raw)   → dígitos canônicos "55+DDD+local" (best-effort); '' se sem dígito.
//   toE164BR(raw)   → "+<digitsBR>" ou null. Drop-in para validation.toE164, mas BR-aware
//                     (garante DDI 55) — usado na ESCRITA do lead (envio Evolution depende).
//   matchKeys(raw)  → array de variantes de dígitos {com/sem 55, com/sem 9º dígito} para
//                     DEDUP por telefone (lookup), fazendo formulário Meta (sem DDI) e
//                     WhatsApp (com 55), e 9º dígito presente/ausente, CONVERGIREM.
//
// NÃO reescreve dados gravados: a convergência de leads em formato divergente acontece
// na camada de dedup (matchKeys), não mutando a base.
//

// DDDs válidos (lista oficial ANATEL — espelho de dashboard/lib/telefone.js).
const DDDS_BR = new Set([
  '11', '12', '13', '14', '15', '16', '17', '18', '19',
  '21', '22', '24', '27', '28',
  '31', '32', '33', '34', '35', '37', '38',
  '41', '42', '43', '44', '45', '46', '47', '48', '49',
  '51', '53', '54', '55',
  '61', '62', '63', '64', '65', '66', '67', '68', '69',
  '71', '73', '74', '75', '77', '79',
  '81', '82', '83', '84', '85', '86', '87', '88', '89',
  '91', '92', '93', '94', '95', '96', '97', '98', '99',
]);

// Só dígitos; múltiplos números separados por / , ; \n → pega o 1º.
function _digits(raw) {
  if (raw == null) return '';
  return String(raw).split(/[/,;\n]/)[0].replace(/\D+/g, '');
}

// "55" + DDD + número local, best-effort. Mantém intacto o que não é número BR
// reconhecível (ex.: LID de grupo 1203… com 18 dígitos) — devolve os dígitos como vieram.
function digitsBR(raw) {
  const d = _digits(raw);
  if (!d) return '';
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d;
  if (d.length === 10 || d.length === 11) return '55' + d;
  return d;
}

function toE164BR(raw) {
  const d = digitsBR(raw);
  return d ? '+' + d : null;
}

// Parte local (DDD + número) a partir de dígitos quaisquer.
function _local(d) {
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d.slice(2);
  return d;
}

// Variantes de dígitos para casar o MESMO contato em formatos diferentes.
function matchKeys(raw) {
  const d = _digits(raw);
  if (!d) return [];
  const local = _local(d);
  const out = new Set([d, local, '55' + local]);

  // Só mexe no 9º dígito quando o local é DDD válido + celular reconhecível.
  if (local.length === 10 || local.length === 11) {
    const ddd = local.slice(0, 2);
    const num = local.slice(2);
    // Gera as duas formas (com/sem 9º dígito) p/ casar o mesmo contato. NÃO restringe
    // o 1º dígito local a [6-9]: no celular moderno o dígito após o "9" é livre
    // (ex.: 9 1111-2222). Como o match é por igualdade EXATA de dígitos, uma variante
    // a mais (improvável de existir como outro lead) não funde gente diferente.
    if (DDDS_BR.has(ddd)) {
      if (num.length === 9 && num[0] === '9') {
        const sem9 = ddd + num.slice(1);                 // remove o 9
        out.add(sem9); out.add('55' + sem9);
      } else if (num.length === 8) {
        const com9 = ddd + '9' + num;                    // adiciona o 9
        out.add(com9); out.add('55' + com9);
      }
    }
  }
  return [...out].filter(Boolean);
}

module.exports = { DDDS_BR, digitsBR, toE164BR, matchKeys };
