import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LectorDeGmail } from './client.js';
import { fetchNewMessages } from './fetch.js';
import { mensajeSchema, type MensajeGmail } from './schemas.js';
import type { EstadoDeSync } from '../sync-state.js';

const b64url = (s: string): string =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

function mensajeFalso(id: string, fecha: string): MensajeGmail {
  return mensajeSchema.parse({
    id,
    threadId: `thread-${id}`,
    labelIds: ['INBOX'],
    internalDate: String(new Date(fecha).getTime()),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: `Alguien <${id}@acme.com>` },
        { name: 'Subject', value: `asunto ${id}` },
      ],
      body: { data: b64url(`cuerpo de ${id}`) },
    },
  });
}

interface Llamadas {
  historial: number;
  perfil: number;
  listas: Array<{ q?: string | undefined; maxResults?: number | undefined }>;
}

function error404(): Error {
  return Object.assign(new Error('Requested entity was not found.'), {
    response: { status: 404 },
  });
}

function lectorFalso(opciones: {
  historial?: () => Promise<{
    history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
    historyId?: string;
    nextPageToken?: string;
  }>;
  mensajesPorFecha?: string[];
  nextPageTokenEnLista?: string;
  historyIdDelPerfil?: string;
  fechas?: Record<string, string>;
  /** Ids para los que `obtenerMensaje` tira un 404, como un mensaje fantasma real. */
  fantasmas?: readonly string[];
}): { lector: LectorDeGmail; llamadas: Llamadas } {
  const llamadas: Llamadas = { historial: 0, perfil: 0, listas: [] };

  const lector: LectorDeGmail = {
    async obtenerPerfil() {
      llamadas.perfil += 1;
      return { historyId: opciones.historyIdDelPerfil ?? '9999' };
    },
    async listarHistorial() {
      llamadas.historial += 1;
      if (!opciones.historial) return {};
      return opciones.historial();
    },
    async listarMensajes(params) {
      llamadas.listas.push({ q: params.q, maxResults: params.maxResults });
      return {
        messages: (opciones.mensajesPorFecha ?? []).map((id) => ({ id })),
        ...(opciones.nextPageTokenEnLista === undefined
          ? {}
          : { nextPageToken: opciones.nextPageTokenEnLista }),
      };
    },
    async obtenerMensaje(id) {
      if (opciones.fantasmas?.includes(id)) throw error404();
      return mensajeFalso(id, opciones.fechas?.[id] ?? '2026-08-17T10:00:00Z');
    },
  };

  return { lector, llamadas };
}

const sinEstado: EstadoDeSync = {
  historyId: null,
  lastMessageDate: null,
  lastRunAt: null,
  lastSpamSweepAt: null,
};

describe('un id fantasma no tira abajo la corrida', () => {
  // Encontrado en producción (agosto 2026): history.list devolvió un id que ya
  // no estaba para users.messages.get. Sin este manejo, el 404 se propagaba sin
  // capturar y crasheaba el worker entero en loop — el mismo id fantasma volvía
  // a aparecer en cada reintento porque el cursor nunca llegaba a avanzar.

  it('lo saltea y sigue con el resto del lote, vía historial', async () => {
    const { lector } = lectorFalso({
      historial: async () => ({
        history: [
          {
            messagesAdded: [
              { message: { id: 'fantasma' } },
              { message: { id: 'real' } },
            ],
          },
        ],
        historyId: '2000',
      }),
      fantasmas: ['fantasma'],
    });

    const r = await fetchNewMessages(lector, {
      estado: { ...sinEstado, historyId: '1000' },
      maxMensajes: 50,
    });

    assert.deepEqual(r.mensajes.map((m) => m.messageId), ['real']);
    assert.deepEqual(r.mensajesFantasma, ['fantasma']);
    // El cursor de historial avanza igual: no depende de que cada mensaje
    // individual se haya podido traer.
    assert.equal(r.cursorPendiente.historyId, '2000');
  });

  it('lo saltea y sigue con el resto del lote, vía fallback por fecha', async () => {
    const { lector } = lectorFalso({
      historial: async () => {
        throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
      },
      mensajesPorFecha: ['fantasma', 'real'],
      historyIdDelPerfil: '5555',
      fantasmas: ['fantasma'],
    });

    const r = await fetchNewMessages(lector, {
      estado: {
        ...sinEstado,
        historyId: '1000',
        lastMessageDate: new Date('2026-08-10T08:00:00Z'),
      },
      maxMensajes: 50,
    });

    assert.deepEqual(r.mensajes.map((m) => m.messageId), ['real']);
    assert.deepEqual(r.mensajesFantasma, ['fantasma']);
  });

  it('un 500 real (no un 404) sigue propagándose: no es lo mismo que un fantasma', async () => {
    const lector: LectorDeGmail = {
      async obtenerPerfil() {
        return { historyId: '1' };
      },
      async listarHistorial() {
        return {
          history: [{ messagesAdded: [{ message: { id: 'x' } }] }],
          historyId: '2',
        };
      },
      async listarMensajes() {
        return { messages: [] };
      },
      async obtenerMensaje() {
        throw Object.assign(new Error('boom'), { response: { status: 500 } });
      },
    };

    await assert.rejects(
      () => fetchNewMessages(lector, { estado: { ...sinEstado, historyId: '1000' }, maxMensajes: 50 }),
      /boom/,
    );
  });
});

describe('fetchNewMessages', () => {
  it('usa el historial cuando hay cursor', async () => {
    const { lector, llamadas } = lectorFalso({
      historial: async () => ({
        history: [{ messagesAdded: [{ message: { id: 'a' } }, { message: { id: 'b' } }] }],
        historyId: '2000',
      }),
    });

    const r = await fetchNewMessages(lector, {
      estado: { ...sinEstado, historyId: '1000' },
      maxMensajes: 50,
    });

    assert.equal(r.via, 'history');
    assert.equal(llamadas.perfil, 0, 'el camino incremental no necesita getProfile');
    assert.deepEqual(r.mensajes.map((m) => m.messageId), ['a', 'b']);
    assert.equal(r.cursorPendiente.historyId, '2000');
  });

  it('cae al fallback por fecha cuando el cursor expiró con 404', async () => {
    const { lector, llamadas } = lectorFalso({
      historial: async () => {
        throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
      },
      mensajesPorFecha: ['c'],
      historyIdDelPerfil: '5555',
    });

    const r = await fetchNewMessages(lector, {
      estado: {
        ...sinEstado,
        historyId: '1000',
        lastMessageDate: new Date('2026-08-10T08:00:00Z'),
      },
      maxMensajes: 50,
    });

    assert.equal(r.via, 'fallback-fecha');
    assert.match(r.motivoDelFallback ?? '', /expiró \(404\)/);
    assert.equal(llamadas.listas[0]?.q, 'after:2026/08/10');
    assert.equal(r.cursorPendiente.historyId, '5555');
  });

  it('propaga los errores que no son 404', async () => {
    const { lector } = lectorFalso({
      historial: async () => {
        throw Object.assign(new Error('server error'), { response: { status: 500 } });
      },
    });

    await assert.rejects(
      fetchNewMessages(lector, { estado: { ...sinEstado, historyId: '1000' }, maxMensajes: 50 }),
      /server error/,
    );
  });

  it('en la primera corrida arranca por fecha y toma el historyId ANTES de listar', async () => {
    const { lector, llamadas } = lectorFalso({
      mensajesPorFecha: ['d'],
      historyIdDelPerfil: '77',
    });

    const r = await fetchNewMessages(lector, { estado: sinEstado, maxMensajes: 50 });

    assert.equal(r.via, 'fallback-fecha');
    assert.match(r.motivoDelFallback ?? '', /Primera corrida/);
    assert.equal(llamadas.perfil, 1);
    assert.equal(r.cursorPendiente.historyId, '77');
  });

  it('respeta el tope de mensajes por corrida', async () => {
    const { lector } = lectorFalso({
      historial: async () => ({
        history: [
          {
            messagesAdded: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ message: { id } })),
          },
        ],
        historyId: '2000',
      }),
    });

    const r = await fetchNewMessages(lector, {
      estado: { ...sinEstado, historyId: '1000' },
      maxMensajes: 3,
    });

    assert.equal(r.mensajes.length, 3);
    assert.equal(r.truncadoPorTope, true);
  });

  it('NO avanza el historyId si se truncó: esos mensajes quedarían afuera para siempre', async () => {
    const { lector } = lectorFalso({
      historial: async () => ({
        history: [{ messagesAdded: ['a', 'b', 'c'].map((id) => ({ message: { id } })) }],
        historyId: '2000',
      }),
    });

    const r = await fetchNewMessages(lector, {
      estado: { ...sinEstado, historyId: '1000' },
      maxMensajes: 2,
    });

    assert.equal(r.truncadoPorTope, true);
    assert.equal(r.cursorPendiente.historyId, '1000', 'tiene que quedarse en el cursor viejo');
  });

  it('devuelve los mensajes ordenados por fecha y el cursor apunta al último', async () => {
    const { lector } = lectorFalso({
      historial: async () => ({
        history: [{ messagesAdded: [{ message: { id: 'nuevo' } }, { message: { id: 'viejo' } }] }],
        historyId: '2000',
      }),
      fechas: {
        nuevo: '2026-08-17T15:00:00Z',
        viejo: '2026-08-15T09:00:00Z',
      },
    });

    const r = await fetchNewMessages(lector, {
      estado: { ...sinEstado, historyId: '1000' },
      maxMensajes: 50,
    });

    assert.deepEqual(r.mensajes.map((m) => m.messageId), ['viejo', 'nuevo']);
    assert.equal(r.cursorPendiente.lastMessageDate?.toISOString(), '2026-08-17T15:00:00.000Z');
  });

  it('sin mensajes nuevos conserva la fecha anterior', async () => {
    const { lector } = lectorFalso({ historial: async () => ({ historyId: '2000' }) });
    const antes = new Date('2026-08-01T00:00:00Z');

    const r = await fetchNewMessages(lector, {
      estado: { ...sinEstado, historyId: '1000', lastMessageDate: antes },
      maxMensajes: 50,
    });

    assert.equal(r.mensajes.length, 0);
    assert.equal(r.cursorPendiente.lastMessageDate?.toISOString(), antes.toISOString());
  });

  it('deduplica ids repetidos del historial', async () => {
    const { lector } = lectorFalso({
      historial: async () => ({
        history: [
          { messagesAdded: [{ message: { id: 'a' } }] },
          { messagesAdded: [{ message: { id: 'a' } }] },
        ],
        historyId: '2000',
      }),
    });

    const r = await fetchNewMessages(lector, {
      estado: { ...sinEstado, historyId: '1000' },
      maxMensajes: 50,
    });

    assert.equal(r.mensajes.length, 1);
  });
});

describe('el fallback por fecha no puede dejar mensajes atrás', () => {
  // Los tres tests de este bloque cubren un bug que llegó a producción: mensajes
  // que el worker nunca procesaba y de los que nadie se enteraba.

  it('procesa del más viejo al más nuevo, no al revés', async () => {
    // Gmail devuelve del más nuevo al más viejo. Quedarse con los primeros N que
    // devuelve es quedarse con los más nuevos, y como el cursor avanza, los viejos
    // quedan atrás para siempre.
    const { lector } = lectorFalso({
      mensajesPorFecha: ['nuevo', 'medio', 'viejo'],
      fechas: {
        nuevo: '2026-08-20T10:00:00Z',
        medio: '2026-08-18T10:00:00Z',
        viejo: '2026-08-16T10:00:00Z',
      },
    });

    const r = await fetchNewMessages(lector, { estado: sinEstado, maxMensajes: 2 });

    assert.deepEqual(
      r.mensajes.map((m) => m.messageId),
      ['viejo', 'medio'],
      'se queda con los dos más viejos, no con los dos más nuevos',
    );
    assert.equal(r.truncadoPorTope, true);
  });

  it('no avanza la fecha del cursor cuando se truncó', async () => {
    // Es la misma regla que ya tenía el historyId. Antes la fecha avanzaba igual,
    // y como el fallback es el único camino mientras se trunca, el cursor pasaba
    // por encima de lo que no se trajo.
    const previa = new Date('2026-08-01T00:00:00Z');
    const { lector } = lectorFalso({
      mensajesPorFecha: ['a', 'b', 'c'],
      fechas: {
        a: '2026-08-20T10:00:00Z',
        b: '2026-08-18T10:00:00Z',
        c: '2026-08-16T10:00:00Z',
      },
    });

    const r = await fetchNewMessages(lector, {
      estado: { ...sinEstado, lastMessageDate: previa },
      maxMensajes: 1,
    });

    assert.equal(r.truncadoPorTope, true);
    assert.deepEqual(r.cursorPendiente.lastMessageDate, previa, 'la fecha no se movió');
  });

  it('sí avanza la fecha cuando trajo todo', async () => {
    const { lector } = lectorFalso({
      mensajesPorFecha: ['a', 'b'],
      fechas: { a: '2026-08-20T10:00:00Z', b: '2026-08-18T10:00:00Z' },
    });

    const r = await fetchNewMessages(lector, { estado: sinEstado, maxMensajes: 50 });

    assert.equal(r.truncadoPorTope, false);
    assert.equal(
      r.cursorPendiente.lastMessageDate?.toISOString(),
      '2026-08-20T10:00:00.000Z',
      'avanza al más nuevo de los procesados',
    );
  });

  it('descarta los ya vistos ANTES de aplicar el tope', async () => {
    // Como `after:` es por día, cada corrida vuelve a listar el día entero. Si el
    // tope se llenara con los ya procesados, el worker nunca llegaría a los nuevos.
    const { lector } = lectorFalso({
      mensajesPorFecha: ['nuevo2', 'nuevo1', 'visto2', 'visto1'],
      fechas: {
        nuevo2: '2026-08-20T12:00:00Z',
        nuevo1: '2026-08-20T11:00:00Z',
        visto2: '2026-08-19T12:00:00Z',
        visto1: '2026-08-19T11:00:00Z',
      },
    });

    const r = await fetchNewMessages(lector, {
      estado: sinEstado,
      maxMensajes: 2,
      sinVer: async (ids) => ids.filter((id) => !id.startsWith('visto')),
    });

    assert.deepEqual(
      r.mensajes.map((m) => m.messageId),
      ['nuevo1', 'nuevo2'],
      'el cupo se gasta en los nuevos, no en los que se iban a saltear igual',
    );
    assert.equal(r.truncadoPorTope, false, 'no quedaron pendientes sin ver');
  });

  it('sin filtro de vistos se comporta igual que antes', async () => {
    const { lector } = lectorFalso({
      mensajesPorFecha: ['a', 'b'],
      fechas: { a: '2026-08-20T10:00:00Z', b: '2026-08-18T10:00:00Z' },
    });

    const r = await fetchNewMessages(lector, { estado: sinEstado, maxMensajes: 50 });
    assert.equal(r.mensajes.length, 2);
  });
});
