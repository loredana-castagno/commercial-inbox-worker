import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { SnovClient } from './client.js';
import { SnovWriter } from './escritor.js';

interface RespuestaFalsa {
  readonly status: number;
  readonly cuerpo: unknown;
}

function clienteFalso(
  escrituraHabilitada: boolean,
  registrar?: (url: string, cuerpo: unknown) => void,
  responder?: RespuestaFalsa,
): SnovClient {
  const fetchImpl: typeof fetch = async (entrada, init) => {
    const url = String(entrada);

    // El cliente manda JSON o form-encoded según la ruta, así que el doble tiene
    // que entender los dos: si acá se asumiera JSON siempre, un cuerpo de
    // formulario reventaría el `JSON.parse` y el test fallaría por el doble, no
    // por el código.
    const tipo = new Headers(init?.headers).get('content-type') ?? '';
    let cuerpo: unknown;
    if (init?.body !== undefined) {
      if (tipo.includes('form-urlencoded')) {
        const params = new URLSearchParams(String(init.body));
        // Una clave repetida (`items[]`) se devuelve como array; el resto, plano.
        cuerpo = Object.fromEntries(
          [...new Set(params.keys())].map((k) => {
            const todos = params.getAll(k);
            return [k, todos.length > 1 || k.endsWith('[]') ? todos : todos[0]];
          }),
        );
      } else {
        cuerpo = JSON.parse(String(init.body));
      }
    }

    if (url.endsWith('/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    registrar?.(url, cuerpo);
    const r = responder ?? { status: 200, cuerpo: { success: true } };
    return new Response(JSON.stringify(r.cuerpo), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return new SnovClient({
    clientId: 'id',
    clientSecret: 'secret',
    apiBase: 'https://api.snov.io',
    escrituraHabilitada,
    fetchImpl,
  });
}

describe('la barrera de escritura no se puede esquivar', () => {
  it('sin el flag, SnovWriter.crear devuelve undefined', () => {
    assert.equal(SnovWriter.crear(clienteFalso(false), { externalWriteEnabled: false }), undefined);
  });

  it('con el flag, devuelve un writer', () => {
    assert.ok(SnovWriter.crear(clienteFalso(true), { externalWriteEnabled: true }));
  });

  it('llamar a escribir() directo sobre un cliente de lectura tira antes de la red', async () => {
    // El camino que la barrera de tipos no cubre: saltearse SnovWriter.
    let toco = false;
    const cliente = clienteFalso(false, () => {
      toco = true;
    });

    await assert.rejects(
      () => cliente.escribir('add-prospect-to-list', z.unknown(), {}),
      /Escritura en Snov deshabilitada/,
    );
    assert.equal(toco, false, 'no salió ni una request');
  });
});

describe('agregarALista', () => {
  it('pega en add-prospect-to-list con email, listId y createDuplicates', async () => {
    // `createDuplicates` no es opcional: sin él, un prospect que ya existe en otra
    // lista —todos los que responden— no se agrega. Snov le actualiza los datos,
    // lo deja donde estaba y responde added:false. Medido contra la API real
    // (SPEC.md § listas).
    const llamadas: { url: string; cuerpo: unknown }[] = [];
    const writer = SnovWriter.crear(
      clienteFalso(true, (url, cuerpo) => llamadas.push({ url, cuerpo })),
      { externalWriteEnabled: true },
    );

    await writer?.agregarALista('lead@empresa.com', '3000001', { fullName: 'Una Persona' });

    assert.equal(llamadas.length, 1);
    assert.match(llamadas[0]?.url ?? '', /\/v1\/add-prospect-to-list$/);
    assert.deepEqual(llamadas[0]?.cuerpo, {
      email: 'lead@empresa.com',
      listId: '3000001',
      createDuplicates: 'true',
      fullName: 'Una Persona',
    });
  });

  it('sin nombre no manda la clave vacía', async () => {
    const llamadas: unknown[] = [];
    const writer = SnovWriter.crear(clienteFalso(true, (_u, c) => llamadas.push(c)), {
      externalWriteEnabled: true,
    });

    await writer?.agregarALista('lead@empresa.com', '1');
    assert.deepEqual(llamadas[0], {
      email: 'lead@empresa.com',
      listId: '1',
      createDuplicates: 'true',
    });
  });
});

describe('el duplicado no es un error', () => {
  // Verificado contra la API real: reagregar el mismo prospect a la misma lista
  // devuelve 422, no un éxito idempotente (SPEC.md § Endpoints).
  const DUPLICADO = {
    status: 422,
    cuerpo: {
      success: false,
      added: false,
      errors: 'Prospect with same email already exists in your list',
    },
  };

  it('un 422 de duplicado sale como ya-estaba', async () => {
    const writer = SnovWriter.crear(clienteFalso(true, undefined, DUPLICADO), {
      externalWriteEnabled: true,
    });
    assert.deepEqual(await writer?.agregarALista('lead@empresa.com', '1'), {
      estado: 'ya-estaba',
    });
  });

  it('un alta nueva sale como agregado', async () => {
    const writer = SnovWriter.crear(clienteFalso(true), { externalWriteEnabled: true });
    const r = await writer?.agregarALista('lead@empresa.com', '1');
    assert.equal(r?.estado, 'agregado');
  });

  it('otro 422 sigue fallando fuerte', async () => {
    // Tragarse cualquier 422 convertiría un error de datos en un éxito silencioso.
    const writer = SnovWriter.crear(
      clienteFalso(true, undefined, {
        status: 422,
        cuerpo: { success: false, errors: 'Invalid email format' },
      }),
      { externalWriteEnabled: true },
    );
    await assert.rejects(() => writer!.agregarALista('roto', '1'), /422/);
  });

  it('un 500 sigue fallando', async () => {
    const writer = SnovWriter.crear(
      clienteFalso(true, undefined, { status: 500, cuerpo: { success: false } }),
      { externalWriteEnabled: true },
    );
    await assert.rejects(() => writer!.agregarALista('lead@empresa.com', '1'), /500/);
  });
});

describe('agregarADoNotEmail', () => {
  it('manda items[] form-encoded, con el token en el cuerpo', async () => {
    // Cada pieza de esto costó una vuelta contra la API real, y ninguna salía de
    // la doc web (SPEC.md § do-not-email):
    //   - la ruta `do-not-email-list` la dio el soporte, después de que la doc
    //     pública mandara a dos rutas inexistentes (404);
    //   - el campo `items[]` y el form-encoding salieron del ejemplo en Python de
    //     `reference/snov-api.html`, después de que `email` y `emails` en JSON
    //     dieran el mismo `400 "Emails list is empty"`.
    // Este test existe para que no se vuelvan a cambiar por lo que "parece
    // razonable" o por lo que dice una doc que ya falló tres veces.
    const llamadas: { url: string; cuerpo: unknown }[] = [];
    const writer = SnovWriter.crear(
      clienteFalso(true, (url, cuerpo) => llamadas.push({ url, cuerpo })),
      { externalWriteEnabled: true },
    );

    await writer?.agregarADoNotEmail('rebota@empresa.com', '1000001');

    assert.match(llamadas[0]?.url ?? '', /\/v1\/do-not-email-list$/);
    assert.deepEqual(llamadas[0]?.cuerpo, {
      access_token: 't',
      'items[]': ['rebota@empresa.com'],
      listId: '1000001',
    });
  });

  it('el listId es obligatorio en el tipo, no un opcional con comentario', () => {
    // La cuenta tiene siete listas de do-not-contact, dos con decenas de miles de
    // entradas. Una baja en la equivocada responde 200 y no protege de nada.
    // Si alguien vuelve a hacer opcional este parametro, esto deja de compilar.
    const firma: (email: string, listaId: string) => unknown =
      SnovWriter.prototype.agregarADoNotEmail;
    assert.equal(firma.length, 2, 'agregarADoNotEmail toma email y listaId');
  });
});

describe('listarListasDeDoNotEmail', () => {
  it('va a /v2/blacklists, no a /v1/', async () => {
    // La lectura de estas listas vive en **otra versión de la API**. Pedirla en
    // `/v1/do-not-email-list` —el mismo path que la escritura— devuelve 403, que
    // parece falta de permisos y en realidad es que esa ruta no existe. Perseguir
    // ese 403 como si fuera del plan costó una vuelta entera
    // (SPEC.md § do-not-email).
    const llamadas: string[] = [];
    const cliente = clienteFalso(false, (url) => llamadas.push(url), {
      status: 200,
      cuerpo: { success: true, data: [] },
    });

    await cliente.listarListasDeDoNotEmail();

    assert.match(llamadas[0] ?? '', /\/v2\/blacklists$/);
  });
});

describe('un 200 no alcanza para decir que quedó en la lista', () => {
  // Encontrado en producción (agosto 2026): add-prospect-to-list con un prospect
  // que ya existe en otra lista devuelve 200, le actualiza los datos y lo deja
  // donde estaba. Como todo el que responde una campaña ya existe, ese es el caso
  // normal — y tragarlo como éxito dejó a NO_THANKS / NOT_NOW / REFERRAL sin
  // llegar nunca a su lista, con el Sheet diciendo que sí.
  it('added:false falla fuerte en vez de reportar éxito', async () => {
    const writer = SnovWriter.crear(
      clienteFalso(true, undefined, {
        status: 200,
        cuerpo: { success: true, added: false, updated: true },
      }),
      { externalWriteEnabled: true },
    );

    await assert.rejects(
      () => writer!.agregarALista('ya.existe@empresa.com', '3000002'),
      /added:false/,
    );
  });

  it('added:true sigue siendo éxito', async () => {
    const writer = SnovWriter.crear(
      clienteFalso(true, undefined, {
        status: 200,
        cuerpo: { success: true, added: true, updated: false },
      }),
      { externalWriteEnabled: true },
    );

    const r = await writer?.agregarALista('nuevo@empresa.com', '1');
    assert.equal(r?.estado, 'agregado');
  });

  it('sin el campo added se comporta como antes', async () => {
    // Si Snov deja de mandarlo, el worker vuelve al comportamiento anterior en
    // vez de romper todas las altas.
    const writer = SnovWriter.crear(
      clienteFalso(true, undefined, { status: 200, cuerpo: { success: true } }),
      { externalWriteEnabled: true },
    );

    const r = await writer?.agregarALista('nuevo@empresa.com', '1');
    assert.equal(r?.estado, 'agregado');
  });
});
