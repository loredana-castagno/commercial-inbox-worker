import { GmailClient, type LectorDeGmail } from './client.js';
import { parsearMensaje, type MensajeParseado } from './parse.js';
import type { EstadoDeSync } from '../sync-state.js';

const DIAS_DE_FALLBACK_INICIAL = 7;

/**
 * Tope duro de ids a listar en el fallback por fecha. Diez páginas.
 *
 * Existe porque el operador `after:` de Gmail **tiene granularidad de día**: no
 * acepta hora. Así que el rango más chico que se puede pedir es "hoy entero", y en
 * esta casilla eso son más de 50 mensajes. Sin este tope, un buzón con mucho
 * volumen haría paginar sin fin antes de procesar nada.
 */
const TOPE_DE_LISTADO = 1000;

export interface CursorPendiente {
  historyId: string | null;
  lastMessageDate: Date | null;
}

export interface ResultadoDeFetch {
  mensajes: MensajeParseado[];
  /** Lo que habría que guardar en SyncState **si** el procesamiento sale bien. */
  cursorPendiente: CursorPendiente;
  via: 'history' | 'fallback-fecha';
  motivoDelFallback: string | null;
  /** true si se cortó por MAX_MESSAGES_PER_RUN y quedan mensajes sin traer. */
  truncadoPorTope: boolean;
  /**
   * Ids que `history.list`/`messages.list` devolvió pero que al pedir el
   * contenido con `users.messages.get` ya no estaban (404). Se saltean, no
   * frenan la corrida — pero se reportan porque no es lo esperable: Gmail no
   * suele listar un id y después no tenerlo.
   */
  mensajesFantasma: readonly string[];
}

function fechaParaQuery(fecha: Date): string {
  const y = fecha.getUTCFullYear();
  const m = String(fecha.getUTCMonth() + 1).padStart(2, '0');
  const d = String(fecha.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

/** IDs nuevos desde el cursor incremental. Puede tirar 404 si el cursor expiró. */
async function idsDesdeHistorial(
  client: LectorDeGmail,
  startHistoryId: string,
  tope: number,
): Promise<{ ids: string[]; historyId: string | null; truncado: boolean }> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let historyId: string | null = null;
  let truncado = false;

  do {
    const pagina = await client.listarHistorial({
      startHistoryId,
      ...(pageToken === undefined ? {} : { pageToken }),
    });

    historyId = pagina.historyId ?? historyId;

    for (const entrada of pagina.history ?? []) {
      for (const agregado of entrada.messagesAdded ?? []) {
        ids.add(agregado.message.id);
        if (ids.size >= tope) {
          truncado = true;
          break;
        }
      }
      if (truncado) break;
    }

    pageToken = truncado ? undefined : (pagina.nextPageToken ?? undefined);
  } while (pageToken !== undefined);

  return { ids: [...ids], historyId, truncado };
}

/**
 * IDs del rango de fechas, **de los más viejos a los más nuevos** y sin los que ya
 * se procesaron.
 *
 * Las dos cosas importan y las dos costaron un bug en producción:
 *
 * **El orden.** Gmail devuelve del más nuevo al más viejo y no ofrece orden
 * ascendente, así que quedarse con "los primeros N que devuelve" es quedarse con
 * los más nuevos. Combinado con un cursor que avanza, los viejos quedan atrás del
 * cursor y **no se vuelven a listar nunca**. Por eso se trae el rango entero y se
 * invierte: se procesa el atraso en orden, sin agujeros.
 *
 * **El filtro de vistos.** Como `after:` es por día, cada corrida vuelve a listar
 * todo el día. Si el tope se llenara con los ya procesados, el worker nunca
 * llegaría a los nuevos: avanzaría cero y se quedaría trabado en el mismo bloque.
 */
async function idsPorFecha(
  client: LectorDeGmail,
  desde: Date,
  tope: number,
  sinVer: ((ids: readonly string[]) => Promise<string[]>) | undefined,
): Promise<{ ids: string[]; truncado: boolean }> {
  const todos: string[] = [];
  let pageToken: string | undefined;

  do {
    const pagina = await client.listarMensajes({
      q: `after:${fechaParaQuery(desde)}`,
      maxResults: 100,
      ...(pageToken === undefined ? {} : { pageToken }),
    });

    for (const m of pagina.messages ?? []) todos.push(m.id);
    pageToken = pagina.nextPageToken ?? undefined;
  } while (pageToken !== undefined && todos.length < TOPE_DE_LISTADO);

  // Gmail los da del más nuevo al más viejo: invertir da el orden cronológico.
  const cronologico = todos.reverse();
  const pendientes = sinVer === undefined ? cronologico : await sinVer(cronologico);

  return { ids: pendientes.slice(0, tope), truncado: pendientes.length > tope };
}

/**
 * Trae los mensajes nuevos desde el cursor.
 *
 * Camino normal: `users.history.list`. Gmail retiene el historial incremental
 * alrededor de una semana, así que si el worker estuvo parado más que eso el
 * cursor devuelve 404 y se cae a `users.messages.list` por fecha.
 *
 * No escribe en `SyncState`: devuelve el cursor que *habría* que guardar. Avanzarlo
 * es responsabilidad de quien procesa, y recién cuando el procesamiento salió bien.
 *
 * No filtra por label a propósito: al worker le sirve ver todo lo que entra. La
 * extracción del dataset histórico de la Fase 2 necesita lo contrario — listar por
 * label ya aplicado — y eso va en un método aparte. No agregarle un parámetro de
 * label a esta función: son dos recorridos distintos con dos cursores distintos.
 */
export async function fetchNewMessages(
  client: LectorDeGmail,
  opciones: {
    estado: EstadoDeSync;
    maxMensajes: number;
    /**
     * Filtra los ids que este worker ya procesó. Lo implementa quien tiene la base
     * — el fetch no la conoce — y se usa **antes** de aplicar el tope, para que el
     * cupo se gaste en mensajes nuevos y no en los que se van a saltear igual.
     */
    sinVer?: (ids: readonly string[]) => Promise<string[]>;
  },
): Promise<ResultadoDeFetch> {
  const { estado, maxMensajes } = opciones;

  let ids: string[] = [];
  let historyIdNuevo: string | null = null;
  let via: ResultadoDeFetch['via'] = 'history';
  let motivoDelFallback: string | null = null;
  let truncado = false;

  if (estado.historyId !== null) {
    try {
      const desdeHistorial = await idsDesdeHistorial(client, estado.historyId, maxMensajes);
      ids = desdeHistorial.ids;
      historyIdNuevo = desdeHistorial.historyId;
      truncado = desdeHistorial.truncado;
    } catch (error) {
      if (!GmailClient.esHistorialExpirado(error)) throw error;
      motivoDelFallback = `El cursor ${estado.historyId} expiró (404): Gmail retiene el historial ~1 semana.`;
    }
  } else {
    motivoDelFallback =
      estado.lastMessageDate === null
        ? 'Primera corrida: no hay cursor todavía.'
        : 'No hay historyId guardado.';
  }

  if (motivoDelFallback !== null) {
    via = 'fallback-fecha';

    // El historyId se toma ANTES de listar: si llega un mail mientras corremos,
    // el cursor viejo lo incluye en la próxima corrida en vez de saltearlo.
    const perfil = await client.obtenerPerfil();
    historyIdNuevo = perfil.historyId ?? null;

    const desde =
      estado.lastMessageDate ??
      new Date(Date.now() - DIAS_DE_FALLBACK_INICIAL * 24 * 60 * 60 * 1000);

    const porFecha = await idsPorFecha(client, desde, maxMensajes, opciones.sinVer);
    ids = porFecha.ids;
    truncado = porFecha.truncado;
  }

  const mensajes: MensajeParseado[] = [];
  const mensajesFantasma: string[] = [];
  for (const id of ids) {
    try {
      mensajes.push(parsearMensaje(await client.obtenerMensaje(id)));
    } catch (error) {
      // Un id fantasma no puede tirar abajo el lote entero: los demás ids de esta
      // misma corrida están bien, y sin este catch un solo 404 crashea el worker
      // en un loop —el mismo id vuelve a listarse en cada reintento porque el
      // cursor nunca llega a avanzar— hasta que alguien lo nota desde afuera.
      if (!GmailClient.esMensajeInexistente(error)) throw error;
      mensajesFantasma.push(id);
    }
  }
  mensajes.sort((a, b) => a.date.getTime() - b.date.getTime());

  const ultimo = mensajes.at(-1);

  return {
    mensajes,
    cursorPendiente: {
      // Si se cortó por el tope quedan mensajes sin traer: avanzar el historyId
      // los dejaría afuera para siempre, así que se mantiene el cursor viejo y la
      // próxima corrida los vuelve a listar (la PK de EmailTriage evita duplicar).
      historyId: truncado ? estado.historyId : historyIdNuevo,
      // Misma regla para la fecha, y por el mismo motivo. Antes ésta avanzaba
      // aunque se hubiera truncado: como el fallback por fecha es el único camino
      // mientras se trunca, el cursor efectivo pasaba por encima de mensajes que
      // nunca se trajeron y quedaban perdidos en silencio.
      lastMessageDate: truncado ? estado.lastMessageDate : (ultimo?.date ?? estado.lastMessageDate),
    },
    via,
    motivoDelFallback,
    mensajesFantasma,
    truncadoPorTope: truncado,
  };
}
