'use strict';
//
// verifica-cifra.js — ADR-051 Fase 0 (T-RESTORE-01).
// Confere, no banco RESTAURADO, que os segredos cifrados abrem com as chaves de criptografia atuais.
// Nunca imprime segredo: só "ok", "falhou" ou "ausente" e o tamanho do texto aberto.
// Roda dentro da imagem do dashboard (tem o módulo pg), numa rede docker interna sem saída.
//
const crypto = require('crypto');
const { Client } = require('pg');

function abrir(chave, b64) {
  if (!b64) return null;
  try {
    const k = crypto.createHash('sha256').update(chave).digest();
    const raw = Buffer.from(b64, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch (_e) {
    return '';
  }
}

async function main() {
  const appKey = process.env.APP_ENCRYPTION_KEY;
  const lmKey = process.env.LM_ENCRYPTION_KEY;
  if (!appKey || !lmKey) throw new Error('chaves de criptografia ausentes no ambiente do teste');

  const c = new Client({ connectionString: process.env.RESTORE_DATABASE_URL });
  await c.connect();
  const res = {};
  const conferir = async (nome, sql, chave, validar) => {
    const rows = (await c.query(sql)).rows;
    if (!rows.length) { res[nome] = { estado: 'ausente' }; return; }
    let ok = 0; let falhou = 0;
    for (const r of rows) {
      const t = abrir(chave, r.v);
      if (t && validar(t)) ok++; else falhou++;
    }
    res[nome] = { estado: falhou ? 'falhou' : 'ok', abertos: ok, falharam: falhou };
  };

  await conferir('certificado_digital',
    "SELECT chave_cifrada AS v FROM compasso.certificado WHERE status = 'ativo' AND chave_cifrada IS NOT NULL",
    appKey, (t) => t.includes('PRIVATE KEY'));
  await conferir('credencial_extranet_lm',
    "SELECT config->>'credential_enc' AS v FROM resources.resource_source_binding WHERE config ? 'credential_enc'",
    lmKey, (t) => t.length > 0);
  await conferir('token_evolution_dashboard',
    'SELECT evolution_token_enc AS v FROM app.franquia WHERE evolution_token_enc IS NOT NULL',
    appKey, (t) => t.length > 0);

  await c.end();
  console.log(JSON.stringify(res));
  const falhas = Object.values(res).filter((x) => x.estado === 'falhou').length;
  process.exit(falhas ? 1 : 0);
}

main().catch((e) => { console.error('erro:', e.message); process.exit(2); });
