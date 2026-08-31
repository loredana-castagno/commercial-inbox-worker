import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SnovWriter } from '../snov/escritor.js';
import type { Accion } from './acciones.js';
import { crearEjecutor } from './ejecutores.js';
import { ejecutar, type Barreras } from './executor.js';

const CONTEXTO = {
  emailDelRemitente: 'lead@empresa.com',
  nombreDelRemitente: 'Una Persona',
  // Ya resuelto por el worker: el clasificador con el heurístico de respaldo.
  primerNombreDelRemitente: 'Una',
  gmailMessageId: '18f6c827742c0dc9',
  gmailThreadId: '18f6c827742c0dc9',
  asunto: 'Re: quick question',
  cuerpo: 'Me interesa, hablemos.',
};

function writerFalso(registro: { tipo: string; args: unknown[] }[]): SnovWriter {
  return {
    agregarALista: async (...args: unknown[]) => {
      registro.push({ tipo: 'lista', args });
      return { success: true };
    },
    agregarADoNotEmail: async (...args: unknown[]) => {
      registro.push({ tipo: 'dne', args });
      return { success: true };
    },
  } as unknown as SnovWriter;
}

describe('crearEjecutor', () => {
  it('sin ningún cliente devuelve undefined', () => {
    // Es lo que hace que el executor marque "planeada" en vez de fingir que ejecutó.
    assert.equal(crearEjecutor({}, CONTEXTO), undefined);
  });

  it('sube a la lista con el email y el nombre del remitente', async () => {
    const registro: { tipo: string; args: unknown[] }[] = [];
    const ejecutor = crearEjecutor({ snov: writerFalso(registro) }, CONTEXTO);

    await ejecutor?.({ tipo: 'SUBIR_A_LISTA_SNOV', listaId: '99', nombreDeLista: 'No thanks' });

    assert.deepEqual(registro[0], {
      tipo: 'lista',
      args: ['lead@empresa.com', '99', { fullName: 'Una Persona', firstName: 'Una' }],
    });
  });

  it('subir a lista usa el email de la acción cuando lo trae, no el del contexto', async () => {
    // Es el caso de EMAIL_MODIFIED: hay que sumar la dirección NUEVA a la lista, no
    // la del remitente —que es la vieja, la que está avisando que cambió.
    const registro: { tipo: string; args: unknown[] }[] = [];
    const ejecutor = crearEjecutor({ snov: writerFalso(registro) }, CONTEXTO);

    await ejecutor?.({
      tipo: 'SUBIR_A_LISTA_SNOV',
      listaId: '99',
      nombreDeLista: 'No thanks',
      email: 'nueva@empresa.com',
    });

    assert.deepEqual(registro[0], {
      tipo: 'lista',
      // El nombre sigue siendo el del remitente: es la misma persona, cambió la
      // dirección, no el nombre.
      args: ['nueva@empresa.com', '99', { fullName: 'Una Persona', firstName: 'Una' }],
    });
  });

  it('cuando la acción trae nombre, va ése y no el del remitente', async () => {
    // Es el caso de REFERRAL: el referido es OTRA persona. Con el nombre del
    // remitente, Chris Palmer entra a Snov cargado como "Alex Turner" y la campaña
    // le manda un correo que saluda a otro.
    const registro: { tipo: string; args: unknown[] }[] = [];
    const ejecutor = crearEjecutor({ snov: writerFalso(registro) }, CONTEXTO);

    await ejecutor?.({
      tipo: 'SUBIR_A_LISTA_SNOV',
      listaId: '2000002',
      nombreDeLista: "Leads - Referrals Inbox",
      email: 'cpalmer@northwind.com',
      nombre: 'Chris Palmer',
    });

    assert.deepEqual(registro[0], {
      tipo: 'lista',
      // El firstName se deriva del nombre del referido, no del contexto: es lo que
      // usa el {{first_name}} de la campaña.
      args: ['cpalmer@northwind.com', '2000002', { fullName: 'Chris Palmer', firstName: 'Chris' }],
    });
  });

  it('sin nombre en el remitente, sube solo el email — sin fullName ni firstName', async () => {
    const registro: { tipo: string; args: unknown[] }[] = [];
    const ejecutor = crearEjecutor(
      { snov: writerFalso(registro) },
      { ...CONTEXTO, nombreDelRemitente: null, primerNombreDelRemitente: undefined },
    );

    await ejecutor?.({ tipo: 'SUBIR_A_LISTA_SNOV', listaId: '99', nombreDeLista: 'No thanks' });

    assert.deepEqual(registro[0], { tipo: 'lista', args: ['lead@empresa.com', '99', {}] });
  });

  it('do-not-email usa el email de la acción y el id de lista configurado', async () => {
    // Los handlers ponen ahí la dirección después de comprobar que no es nuestra.
    // El id va explícito: la cuenta tiene siete listas de do-not-contact y una
    // baja en la equivocada responde 200 sin proteger a nadie.
    const registro: { tipo: string; args: unknown[] }[] = [];
    const ejecutor = crearEjecutor(
      { snov: writerFalso(registro), listaDeDoNotEmail: '1000001' },
      CONTEXTO,
    );

    await ejecutor?.({ tipo: 'SUBIR_A_DO_NOT_EMAIL', email: 'otro@empresa.com' });

    assert.deepEqual(registro[0], { tipo: 'dne', args: ['otro@empresa.com', '1000001'] });
  });

  it('sin el id de lista tira, en vez de dejar que Snov elija', async () => {
    // Es la única acción del sistema que no se deshace. Adivinar la lista sería
    // exactamente la falla silenciosa que este proyecto evita: 200 y sin efecto.
    const ejecutor = crearEjecutor({ snov: writerFalso([]) }, CONTEXTO);

    await assert.rejects(
      () => ejecutor?.({ tipo: 'SUBIR_A_DO_NOT_EMAIL', email: 'otro@empresa.com' }) ?? Promise.resolve(),
      /SNOV_DO_NOT_EMAIL_LIST/,
    );
  });
});

describe('lo que todavía no se sabe ejecutar', () => {
  it('tira en vez de tragarlo', async () => {
    const ejecutor = crearEjecutor({ snov: writerFalso([]) }, CONTEXTO);

    for (const [accion, patron] of [
      [{ tipo: 'ETIQUETAR', etiqueta: 'X' }, /Gmail/],
      // El CRM sí se sabe ejecutar; lo que falta acá es el cliente conectado.
      [{ tipo: 'CREAR_LEAD_CRM' }, /CRM/],
    ] as const) {
      await assert.rejects(() => ejecutor?.(accion as Accion) ?? Promise.resolve(), patron);
    }
  });
});

describe('una acción que falla no arrastra a las demás', () => {
  const TODO: Barreras = {
    gmailWriteEnabled: true,
    externalWriteEnabled: true,
    autoCategorias: ['NO_THANKS'],
  };

  it('la falla queda registrada y las siguientes se ejecutan igual', async () => {
    const acciones: Accion[] = [
      { tipo: 'ETIQUETAR', etiqueta: 'NO_THANKS' },
      { tipo: 'SUBIR_A_LISTA_SNOV', listaId: '1', nombreDeLista: 'No thanks' },
    ];

    const r = await ejecutar(
      { categoriaFinal: 'NO_THANKS', categoriaBase: null, acciones },
      TODO,
      async (a) => {
        if (a.tipo === 'ETIQUETAR') throw new Error('HTTP 500 en modify');
      },
    );

    assert.equal(r.resultados[0]?.estado, 'fallida');
    assert.match(r.resultados[0]?.motivo ?? '', /HTTP 500/);
    assert.equal(r.resultados[1]?.estado, 'ejecutada', 'la de Snov salió igual');
  });

  it('si el error trae el cuerpo de la respuesta, lo suma al motivo', async () => {
    // SnovClient y CrmClient adjuntan `.cuerpo` con el texto crudo de la API al
    // tirar — sin esto en el motivo, un 404 llega al Sheet como "HTTP 404 en
    // add-to-do-not-email-list" sin ninguna pista de qué le faltó al pedido
    // (encontrado en producción, agosto 2026).
    const r = await ejecutar(
      {
        categoriaFinal: 'NO_THANKS',
        categoriaBase: null,
        acciones: [{ tipo: 'ETIQUETAR', etiqueta: 'NO_THANKS' }],
      },
      TODO,
      async () => {
        throw Object.assign(new Error('HTTP 404 en add-to-do-not-email-list'), {
          status: 404,
          cuerpo: '{"success":false,"errors":"List not found"}',
        });
      },
    );

    assert.match(r.resultados[0]?.motivo ?? '', /HTTP 404.*List not found/);
  });

  it('una falla deja el mail marcado en Gmail, no solo en el Sheet', async () => {
    // Sin esto, un UNSUBSCRIBE cuya baja en Snov falla queda archivado, con su
    // etiqueta, y sin ninguna señal en la casilla de que algo no salió — la
    // persona pidió salir de las campañas y sigue adentro (agosto 2026).
    const ejecutadas: Accion[] = [];
    const r = await ejecutar(
      {
        categoriaFinal: 'UNSUBSCRIBE',
        categoriaBase: null,
        acciones: [
          { tipo: 'ETIQUETAR', etiqueta: 'UNSUBSCRIBE' },
          { tipo: 'SUBIR_A_DO_NOT_EMAIL', email: 'toni@empresa.com' },
        ],
      },
      { ...TODO, autoCategorias: ['UNSUBSCRIBE'] },
      async (a) => {
        if (a.tipo === 'SUBIR_A_DO_NOT_EMAIL') throw new Error('HTTP 404');
        ejecutadas.push(a);
      },
    );

    const marca = r.resultados.at(-1);
    assert.equal(marca?.accion.tipo, 'ETIQUETAR_REVISION');
    assert.equal(marca?.estado, 'ejecutada');
    assert.ok(
      ejecutadas.some((a) => a.tipo === 'ETIQUETAR_REVISION'),
      'la marca salió de verdad hacia Gmail',
    );
  });

  it('no duplica la marca si la decisión ya la traía', async () => {
    const r = await ejecutar(
      {
        categoriaFinal: 'OTHER',
        categoriaBase: null,
        acciones: [
          { tipo: 'ETIQUETAR_REVISION', etiqueta: 'BOT - TO CHECK' },
          { tipo: 'ETIQUETAR', etiqueta: 'X' },
        ],
      },
      { ...TODO, autoCategorias: [] },
      async (a) => {
        if (a.tipo === 'ETIQUETAR') throw new Error('boom');
      },
    );

    const marcas = r.resultados.filter((x) => x.accion.tipo === 'ETIQUETAR_REVISION');
    assert.equal(marcas.length, 1);
  });

  it('sin GMAIL_WRITE_ENABLED no intenta marcar nada', async () => {
    // La marca es una escritura en la casilla como cualquier otra.
    const r = await ejecutar(
      {
        categoriaFinal: 'NO_THANKS',
        categoriaBase: null,
        acciones: [{ tipo: 'SUBIR_A_LISTA_SNOV', listaId: '1', nombreDeLista: 'No thanks' }],
      },
      { ...TODO, gmailWriteEnabled: false },
      async () => {
        throw new Error('boom');
      },
    );

    assert.equal(r.resultados.filter((x) => x.accion.tipo === 'ETIQUETAR_REVISION').length, 0);
  });

  it('una falla manda el mail a revisión humana', async () => {
    // Aunque la clasificación haya sido perfecta: alguien tiene que decidir si
    // se reintenta.
    const r = await ejecutar(
      {
        categoriaFinal: 'NO_THANKS',
        categoriaBase: null,
        acciones: [{ tipo: 'ETIQUETAR', etiqueta: 'NO_THANKS' }],
      },
      TODO,
      async () => {
        throw new Error('boom');
      },
    );

    assert.equal(r.necesitaRevision, true);
    // 2 y no 1: con Gmail caído para todo, el intento de marcar el mail con
    // `BOT - TO CHECK` también falla. Queda registrado en vez de silenciarse.
    assert.match(r.resumen, /2 FALLIDAS/);
  });
});
