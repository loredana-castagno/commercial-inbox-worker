import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GmailClient } from './client.js';
import { GmailAuthError, mapGmailError } from './errors.js';
import { ejecutarConRetry, esReintentable, estadoHttp } from '../retry.js';

const error = (props: Record<string, unknown>): Error => Object.assign(new Error('boom'), props);

describe('esReintentable', () => {
  it('reintenta 429 y 5xx', () => {
    assert.equal(esReintentable(error({ code: 429 })), true);
    assert.equal(esReintentable(error({ response: { status: 503 } })), true);
  });

  it('no reintenta 4xx: un 403 de scope no mejora insistiendo', () => {
    assert.equal(esReintentable(error({ code: 403 })), false);
    assert.equal(esReintentable(error({ response: { status: 404 } })), false);
  });

  it('reintenta cortes de red', () => {
    assert.equal(esReintentable(error({ code: 'ECONNRESET' })), true);
    assert.equal(esReintentable(error({ code: 'EPERM' })), false);
  });
});

describe('estadoHttp', () => {
  it('lo saca de response.status, status o code', () => {
    assert.equal(estadoHttp(error({ response: { status: 429 } })), 429);
    assert.equal(estadoHttp(error({ status: 500 })), 500);
    assert.equal(estadoHttp(error({ code: 404 })), 404);
    assert.equal(estadoHttp(error({ code: 'ECONNRESET' })), undefined);
  });
});

describe('ejecutarConRetry', () => {
  it('reintenta hasta que sale bien', async () => {
    let intentos = 0;
    const esperas: number[] = [];

    const resultado = await ejecutarConRetry(
      async () => {
        intentos += 1;
        if (intentos < 3) throw error({ code: 429 });
        return 'ok';
      },
      { dormir: async (ms) => void esperas.push(ms), jitter: () => 0 },
    );

    assert.equal(resultado, 'ok');
    assert.equal(intentos, 3);
    assert.deepEqual(esperas, [500, 1000], 'el backoff tiene que crecer exponencialmente');
  });

  it('corta enseguida con un error no reintentable', async () => {
    let intentos = 0;

    await assert.rejects(
      ejecutarConRetry(
        async () => {
          intentos += 1;
          throw error({ code: 403 });
        },
        { dormir: async () => {}, jitter: () => 0 },
      ),
    );

    assert.equal(intentos, 1);
  });

  it('se rinde después de agotar los intentos y propaga el último error', async () => {
    let intentos = 0;

    await assert.rejects(
      ejecutarConRetry(
        async () => {
          intentos += 1;
          throw error({ code: 503 });
        },
        { intentos: 4, dormir: async () => {}, jitter: () => 0 },
      ),
      /boom/,
    );

    assert.equal(intentos, 4);
  });
});

describe('GmailClient.esHistorialExpirado', () => {
  it('reconoce el 404 que dispara el fallback por fecha', () => {
    assert.equal(GmailClient.esHistorialExpirado(error({ response: { status: 404 } })), true);
    assert.equal(GmailClient.esHistorialExpirado(error({ response: { status: 500 } })), false);
  });
});

describe('la traducción de errores es el único camino de salida', () => {
  it('mapGmailError sigue traduciendo lo que el retry propaga sin tocar', () => {
    const del403 = error({
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: 'Request had insufficient authentication scopes.',
            errors: [{ reason: 'insufficientPermissions' }],
          },
        },
      },
    });

    const traducido = mapGmailError(del403, { scopeConfigurado: 'gmail.modify' });

    assert.ok(traducido instanceof GmailAuthError);
    assert.equal(traducido.kind, 'scope-insuficiente');
    assert.equal(traducido.cause, del403, 'el error original tiene que quedar en cause');
  });
});
