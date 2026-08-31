import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { CrmClient } from './client.js';
import { CrmError } from './errors.js';
import { CrmWriter, aDecimal } from './escritor.js';

interface RespuestaFalsa {
  readonly status: number;
  readonly cuerpo: unknown;
}

function clienteFalso(
  escrituraHabilitada: boolean,
  registrar?: (url: string, cuerpo: unknown) => void,
  responder?: RespuestaFalsa,
): CrmClient {
  const fetchImpl: typeof fetch = async (entrada, init) => {
    const cuerpo = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    registrar?.(String(entrada), cuerpo);

    const r = responder ?? { status: 200, cuerpo: { success: true, id: 'c1' } };
    return new Response(JSON.stringify(r.cuerpo), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return new CrmClient({
    baseUrl: 'http://127.0.0.1:3000',
    token: 'la-key',
    escrituraHabilitada,
    fetchImpl,
    dormir: async () => {},
  });
}

describe('aDecimal', () => {
  it('convierte el id hexadecimal de Gmail a decimal', () => {
    // El campo se llama gmailMsgIdDec y la extensión lo manda así. Mandar el
    // hexadecimal armaría un marcador de dedup distinto del suyo para el mismo mail.
    assert.equal(aDecimal('18f6c827742c0dc9'), '1798845172959415753');
  });

  it('aguanta ids largos sin perder precisión', () => {
    // Un Number no llega: por eso va con BigInt y no con parseInt.
    assert.equal(aDecimal('ffffffffffffffff'), '18446744073709551615');
  });

  it('rechaza lo que no es hexadecimal en vez de mandar basura', () => {
    assert.throws(() => aDecimal('no-es-un-id'), /hexadecimal/);
  });
});

describe('la barrera de escritura', () => {
  it('sin el flag, CrmWriter.crear devuelve undefined', () => {
    assert.equal(CrmWriter.crear(clienteFalso(false), { externalWriteEnabled: false }), undefined);
  });

  it('escribir() directo sobre un cliente de lectura tira antes de la red', async () => {
    let toco = false;
    const cliente = clienteFalso(false, () => {
      toco = true;
    });

    await assert.rejects(
      () => cliente.escribir(z.unknown(), {}),
      /Escritura en el CRM deshabilitada/,
    );
    assert.equal(toco, false, 'no salió ni una request');
  });
});

describe('el payload', () => {
  function capturar(): { llamadas: { url: string; cuerpo: unknown }[]; writer: CrmWriter } {
    const llamadas: { url: string; cuerpo: unknown }[] = [];
    const writer = CrmWriter.crear(
      clienteFalso(true, (url, cuerpo) => llamadas.push({ url, cuerpo })),
      { externalWriteEnabled: true },
    );
    assert.ok(writer);
    return { llamadas, writer };
  }

  it('manda gmailMsgIdDec, subject y bodyText', async () => {
    const { llamadas, writer } = capturar();
    await writer.crearContacto({
      email: 'juan@acme.com',
      fullName: 'Juan Pérez',
      gmailMsgIdDec: aDecimal('18f6c827742c0dc9'),
      subject: 'Re: Contact from Allison Taylor',
      bodyText: 'Me interesa.',
    });

    assert.deepEqual(llamadas[0]?.cuerpo, {
      email: 'juan@acme.com',
      fullName: 'Juan Pérez',
      gmailMsgIdDec: '1798845172959415753',
      subject: 'Re: Contact from Allison Taylor',
      bodyText: 'Me interesa.',
      source: 'Ally Inbox Bot',
    });
  });

  it('NUNCA manda accountEmail', async () => {
    // Para un caller de servicio da 403 siempre, y el motivo es que el fetch por
    // IMAP resuelve el buzón con el app password del usuario. El tipo no tiene el
    // campo; esto verifica que tampoco se cuele por otro lado.
    const { llamadas, writer } = capturar();
    await writer.crearContacto({ email: 'x@acme.com', gmailMsgIdDec: '1' });

    assert.ok(!Object.hasOwn(llamadas[0]?.cuerpo as object, 'accountEmail'));
  });

  it('pega en /api/leads/from-email con la key en el header', async () => {
    const { llamadas, writer } = capturar();
    await writer.crearContacto({ email: 'x@acme.com', gmailMsgIdDec: '1' });
    assert.match(llamadas[0]?.url ?? '', /\/api\/leads\/from-email$/);
  });
});

describe('el 409 no es un error', () => {
  // El CRM devuelve 409 cuando el contacto existía y nada cambió. Tomado literal,
  // el worker marcaría como fallida la operación que mejor salió — y por la regla
  // de idempotencia, en todo rango reprocesado.
  const DUPLICADO = { status: 409, cuerpo: { duplicate: true, id: 'c99' } };

  it('sale como ya-estaba, con el id', async () => {
    const writer = CrmWriter.crear(clienteFalso(true, undefined, DUPLICADO), {
      externalWriteEnabled: true,
    });
    assert.deepEqual(await writer?.crearContacto({ email: 'x@acme.com', gmailMsgIdDec: '1' }), {
      estado: 'ya-estaba',
      id: 'c99',
    });
  });

  it('un alta nueva sale como creado', async () => {
    const writer = CrmWriter.crear(clienteFalso(true), { externalWriteEnabled: true });
    const r = await writer?.crearContacto({ email: 'x@acme.com', gmailMsgIdDec: '1' });
    assert.equal(r?.estado, 'creado');
  });
});

describe('los errores de configuración se explican', () => {
  it('el 401 apunta a la capa que falta, no a la key', async () => {
    // Son dos capas independientes: proxy.ts y el handler. Un 401 con la key
    // puesta suele ser que se tocó una sola.
    const cliente = clienteFalso(true, undefined, { status: 401, cuerpo: {} });
    const e = await cliente.buscarPorEmail('x@acme.com').catch((x: unknown) => x);
    assert.ok(e instanceof CrmError);
    assert.equal(e.kind, 'auth-a-medias');
    assert.match(e.message, /API_KEY_PATHS.*handler/s);
  });

  it('el 403 dice que sobra accountEmail', async () => {
    const cliente = clienteFalso(true, undefined, { status: 403, cuerpo: {} });
    const e = await cliente.buscarPorEmail('x@acme.com').catch((x: unknown) => x);
    assert.ok(e instanceof CrmError);
    assert.equal(e.kind, 'campo-prohibido');
    assert.match(e.message, /accountEmail/);
  });
});

describe('la consulta', () => {
  it('exists:false es una respuesta, no un error', async () => {
    // El GET devuelve 200 aunque no exista. Un 404 obligaría a distinguir "no
    // está" de "la ruta está mal".
    const cliente = clienteFalso(false, undefined, {
      status: 200,
      cuerpo: { exists: false, suggestedTarget: 'lead', matchedAccount: null },
    });
    const r = await cliente.buscarPorEmail('nadie@acme.com');
    assert.equal(r.exists, false);
  });

  it('deja pasar campos que no conocemos', async () => {
    // El CRM es otro repo con su propio deploy: un campo nuevo no puede romper
    // una corrida acá.
    const cliente = clienteFalso(false, undefined, {
      status: 200,
      cuerpo: { exists: true, campoNuevoDelCrm: 42 },
    });
    assert.equal((await cliente.buscarPorEmail('x@acme.com')).exists, true);
  });
});
