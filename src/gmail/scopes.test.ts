import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compararScopes, esScopeDeGmail, parseScopes } from './scopes.js';

const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const TODO = 'https://mail.google.com/';

describe('compararScopes', () => {
  it('acepta el caso normal: concedido igual a requerido', () => {
    assert.deepEqual(compararScopes([READONLY], [READONLY]), {
      faltantes: [],
      excedentesDeGmail: [],
      excedentesAjenos: [],
    });
  });

  it('detecta el caso que rompe la Fase 4: token de readonly, config en modify', () => {
    const r = compararScopes([READONLY], [MODIFY]);

    assert.deepEqual(r.faltantes, [MODIFY]);
  });

  it('marca como excedente de Gmail el token con modify bajo un config readonly', () => {
    const r = compararScopes([MODIFY], [READONLY]);

    assert.deepEqual(r.faltantes, [], 'modify cubre readonly, no falta nada');
    assert.deepEqual(
      r.excedentesDeGmail,
      [MODIFY],
      'es el rollback engañoso: GMAIL_SCOPE dice readonly y el token puede escribir',
    );
  });

  it('mail.google.com cubre todo, pero excede a readonly', () => {
    assert.deepEqual(compararScopes([TODO], [MODIFY]).faltantes, []);
    assert.deepEqual(compararScopes([TODO], [READONLY]).excedentesDeGmail, [TODO]);
  });

  it('los scopes de identidad no cuentan como excedente de correo', () => {
    const r = compararScopes([READONLY, 'openid', 'https://www.googleapis.com/auth/userinfo.email'], [
      READONLY,
    ]);

    assert.deepEqual(r.excedentesDeGmail, [], 'no dan acceso a mails: no pueden frenar el arranque');
    assert.deepEqual(r.excedentesAjenos, ['openid', 'https://www.googleapis.com/auth/userinfo.email']);
  });

  it('reporta faltante cuando el token no tiene nada de Gmail', () => {
    const r = compararScopes(['https://www.googleapis.com/auth/userinfo.email'], [READONLY]);

    assert.deepEqual(r.faltantes, [READONLY]);
  });
});

describe('esScopeDeGmail', () => {
  it('distingue acceso al correo de scopes de identidad', () => {
    assert.equal(esScopeDeGmail(READONLY), true);
    assert.equal(esScopeDeGmail(MODIFY), true);
    assert.equal(esScopeDeGmail(TODO), true);
    assert.equal(esScopeDeGmail('openid'), false);
    assert.equal(esScopeDeGmail('https://www.googleapis.com/auth/userinfo.email'), false);
  });
});

describe('parseScopes', () => {
  it('parte por espacios y comas', () => {
    assert.deepEqual(parseScopes(`${READONLY} ${MODIFY}`), [READONLY, MODIFY]);
    assert.deepEqual(parseScopes(`${READONLY}, ${MODIFY}`), [READONLY, MODIFY]);
  });

  it('ignora vacíos', () => {
    assert.deepEqual(parseScopes('   '), []);
  });
});
