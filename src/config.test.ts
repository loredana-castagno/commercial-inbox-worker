import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from './config.js';

/**
 * Las validaciones cruzadas: combinaciones válidas variable por variable que
 * revientan —o peor, *no* revientan— a mitad de una corrida.
 */

/** Un env completo y coherente. Cada test rompe una sola cosa. */
const BASE: NodeJS.ProcessEnv = {
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:5555/oauth2callback',
  GMAIL_SCOPE: 'https://www.googleapis.com/auth/gmail.readonly',
  GMAIL_USER_EMAIL: 'ally.taylor@mycompany.co',
  GMAIL_REFRESH_TOKEN: 'token',
  DATABASE_URL: 'file:./data/triage.db',
  ANTHROPIC_API_KEY: 'key',
  ANTHROPIC_MODEL: 'claude-opus-5',
  SNOV_CLIENT_ID: 'id',
  SNOV_CLIENT_SECRET: 'secret',
  SNOV_API_BASE: 'https://api.snov.io',
  SNOV_LIST_NO_THANKS: '1',
  SNOV_LIST_NOT_NOW: '2',
  SNOV_LIST_REFERRALS: '3',
  CRM_BASE_URL: 'http://127.0.0.1:3000',
  AUTO_CATEGORIES: '',
  GMAIL_WRITE_ENABLED: 'false',
  EXTERNAL_WRITE_ENABLED: 'false',
};

const ESCRITURA_TOTAL: NodeJS.ProcessEnv = {
  ...BASE,
  GMAIL_SCOPE: 'https://www.googleapis.com/auth/gmail.modify',
  GMAIL_WRITE_ENABLED: 'true',
  EXTERNAL_WRITE_ENABLED: 'true',
  CRM_SERVICE_TOKEN: 'token-del-crm',
  NODE_ENV: 'production',
};

describe('el default no escribe nada', () => {
  it('un env mínimo bootea en shadow mode', () => {
    const c = loadConfig(BASE);
    assert.equal(c.GMAIL_WRITE_ENABLED, false);
    assert.equal(c.EXTERNAL_WRITE_ENABLED, false);
    assert.deepEqual(c.AUTO_CATEGORIES, []);
  });

  it('no exige el token del CRM para correr sin escritura externa', () => {
    assert.doesNotThrow(() => loadConfig(BASE));
  });
});

describe('escritura en Gmail contra el scope', () => {
  it('rechaza escribir con un scope de solo lectura', () => {
    assert.throws(
      () => loadConfig({ ...BASE, GMAIL_WRITE_ENABLED: 'true' }),
      /solo lectura/,
    );
  });

  it('acepta con gmail.modify', () => {
    assert.doesNotThrow(() =>
      loadConfig({
        ...BASE,
        GMAIL_SCOPE: 'https://www.googleapis.com/auth/gmail.modify',
        GMAIL_WRITE_ENABLED: 'true',
      }),
    );
  });
});

describe('escritura externa', () => {
  it('no se habilita sin la de Gmail', () => {
    assert.throws(
      () => loadConfig({ ...ESCRITURA_TOTAL, GMAIL_WRITE_ENABLED: 'false' }),
      /sin poder etiquetar/,
    );
  });

  it('exige el token del CRM', () => {
    const sinToken = { ...ESCRITURA_TOTAL };
    delete sinToken.CRM_SERVICE_TOKEN;
    assert.throws(() => loadConfig(sinToken), /token del CRM/);
  });

  it('NO sale desde una máquina de desarrollo', () => {
    // El caso que motiva esto: en la máquina de desarrollo hay un CRM local en
    // 127.0.0.1:3000 sobre dev.db. Es la MISMA URL que en producción, así que la
    // URL no distingue nada — el worker escribiría, la API devolvería 200, y el
    // log diría que salió bien contra la base equivocada.
    assert.throws(
      () => loadConfig({ ...ESCRITURA_TOTAL, NODE_ENV: 'development' }),
      /NODE_ENV=development/,
    );
  });

  it('sale con NODE_ENV=production, que es lo que setea PM2', () => {
    assert.doesNotThrow(() => loadConfig(ESCRITURA_TOTAL));
  });
});

describe('AUTO_CATEGORIES', () => {
  it('rechaza una categoría que no existe', () => {
    assert.throws(
      () => loadConfig({ ...BASE, AUTO_CATEGORIES: 'NO_THANKS,INVENTADA' }),
      /no es una categoría/,
    );
  });

  it('rechaza las que siempre van a revisión humana', () => {
    assert.throws(() => loadConfig({ ...BASE, AUTO_CATEGORIES: 'HOT' }), /nunca puede automatizarse/);
  });

  it('acepta una lista válida', () => {
    assert.deepEqual(loadConfig({ ...BASE, AUTO_CATEGORIES: 'UNSUBSCRIBE' }).AUTO_CATEGORIES, [
      'UNSUBSCRIBE',
    ]);
  });
});
