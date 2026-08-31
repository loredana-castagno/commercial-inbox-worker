import { google, type gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { z } from 'zod';
import { mapGmailError } from './errors.js';
import { ejecutarConRetry, estadoHttp } from '../retry.js';
import {
  hiloSchema,
  historialSchema,
  listaDeEtiquetasSchema,
  etiquetaCreadaSchema,
  draftCreadoSchema,
  listaDeMensajesSchema,
  mensajeSchema,
  perfilSchema,
  type MensajeGmail,
} from './schemas.js';

const TIMEOUT_MS = 20_000;

/**
 * Lo que `fetchNewMessages` necesita del cliente. Existe para poder testear la
 * lógica de cursor y fallback con un doble, sin tocar la red ni exponer nada
 * escribible.
 */
export interface LectorDeGmail {
  obtenerPerfil(): Promise<z.infer<typeof perfilSchema>>;
  listarHistorial(params: {
    startHistoryId: string;
    pageToken?: string;
  }): Promise<z.infer<typeof historialSchema>>;
  listarMensajes(params: {
    q?: string;
    labelIds?: string[];
    maxResults?: number;
    pageToken?: string;
    incluirSpamYPapelera?: boolean;
  }): Promise<z.infer<typeof listaDeMensajesSchema>>;
  obtenerMensaje(id: string): Promise<MensajeGmail>;
}

interface OpcionesDeCliente {
  scopeConfigurado: string;
  /**
   * Habilita los métodos de escritura. Sin esto el cliente es de solo lectura y
   * cualquier intento falla antes de tocar la API.
   *
   * Segunda barrera: la primera es que `GmailWriter` no se puede construir sin
   * `GMAIL_WRITE_ENABLED`. Ésta cubre a quien llame al cliente directo.
   */
  escrituraHabilitada?: boolean;
  /** Inyectable para poder testear el backoff sin esperar de verdad. */
  dormir?: (ms: number) => Promise<void>;
}

/**
 * Cliente de Gmail. **De solo lectura salvo que se lo habilite explícitamente**:
 * los métodos de escritura tiran si el cliente no se construyó con
 * `escrituraHabilitada`.
 *
 * **Nunca borra.** No hay método que llame a `messages.delete` ni a `.trash`
 * (CLAUDE.md #4). Y como en Gmail la papelera *es una etiqueta*, `GmailWriter`
 * además rechaza `TRASH` y `SPAM` por nombre — no alcanza con no llamar al
 * endpoint de borrado.
 *
 * La instancia de `googleapis` es privada a propósito. Es la forma de garantizar
 * la invariante de CLAUDE.md #6: no hay manera de llamar a la API sin pasar por
 * `llamar()`, que es lo único que aplica retry y `mapGmailError`. Si se expusiera
 * `gmail` público, cualquier `try/catch` de afuera dejaría la traducción de
 * errores decorativa.
 */
export class GmailClient implements LectorDeGmail {
  readonly #gmail: gmail_v1.Gmail;
  readonly #scopeConfigurado: string;
  readonly #escrituraHabilitada: boolean | undefined;
  readonly #dormir: ((ms: number) => Promise<void>) | undefined;

  constructor(auth: OAuth2Client, opciones: OpcionesDeCliente) {
    this.#gmail = google.gmail({ version: 'v1', auth });
    this.#scopeConfigurado = opciones.scopeConfigurado;
    this.#escrituraHabilitada = opciones.escrituraHabilitada;
    this.#dormir = opciones.dormir;
  }

  /** Único camino de salida hacia la API: retry + traducción de errores. */
  async #llamar<T extends z.ZodTypeAny>(
    descripcion: string,
    schema: T,
    fn: () => Promise<{ data: unknown }>,
  ): Promise<z.infer<T>> {
    try {
      const respuesta = await ejecutarConRetry(
        fn,
        this.#dormir === undefined ? {} : { dormir: this.#dormir },
      );
      return schema.parse(respuesta.data) as z.infer<T>;
    } catch (error) {
      const traducido = mapGmailError(error, { scopeConfigurado: this.#scopeConfigurado });
      if (traducido instanceof Error) throw traducido;
      throw new Error(`Falló ${descripcion}: ${String(traducido)}`);
    }
  }

  /** Errores de la API que el llamador necesita distinguir, no solo propagar. */
  static esHistorialExpirado(error: unknown): boolean {
    return estadoHttp(error) === 404;
  }

  /**
   * Mismo código HTTP que `esHistorialExpirado`, pregunta distinta: acá es
   * `users.messages.get` sobre un id puntual que `history.list` o `messages.list`
   * devolvieron, y que para cuando se pide el contenido ya no está —Gmail lo
   * purgó, o nunca fue un mensaje fetcheable por esta vía—. No es lo mismo que un
   * cursor vencido: ese es un problema del *rango* pedido, este es un solo id
   * fantasma en el medio de un lote que por lo demás está bien.
   */
  static esMensajeInexistente(error: unknown): boolean {
    return estadoHttp(error) === 404;
  }

  async obtenerPerfil(): Promise<z.infer<typeof perfilSchema>> {
    return this.#llamar('users.getProfile', perfilSchema, () =>
      this.#gmail.users.getProfile({ userId: 'me' }, { timeout: TIMEOUT_MS }),
    );
  }

  /**
   * Los nombres de label con espacios o paréntesis no se pueden usar en `q`:
   * "COLD (LAST TRY)" hay que escribirlo `label:cold--last-try-`. Resolver el id
   * y usar `labelIds` evita esa traducción y el 0 resultados silencioso.
   */
  async listarEtiquetas(): Promise<z.infer<typeof listaDeEtiquetasSchema>> {
    return this.#llamar('users.labels.list', listaDeEtiquetasSchema, () =>
      this.#gmail.users.labels.list({ userId: 'me' }, { timeout: TIMEOUT_MS }),
    );
  }

  async listarHistorial(params: {
    startHistoryId: string;
    pageToken?: string;
  }): Promise<z.infer<typeof historialSchema>> {
    return this.#llamar('users.history.list', historialSchema, () =>
      this.#gmail.users.history.list(
        {
          userId: 'me',
          startHistoryId: params.startHistoryId,
          historyTypes: ['messageAdded'],
          ...(params.pageToken === undefined ? {} : { pageToken: params.pageToken }),
        },
        { timeout: TIMEOUT_MS },
      ),
    );
  }

  /**
   * `incluirSpamYPapelera`: Gmail excluye SPAM y TRASH por default, incluso
   * cuando la consulta dice `in:spam`. Hay respuestas reales de prospects que
   * Gmail marca como spam y hoy Ally las rescata a mano — sin este flag el
   * worker no las vería nunca.
   */
  async listarMensajes(params: {
    q?: string;
    labelIds?: string[];
    maxResults?: number;
    pageToken?: string;
    incluirSpamYPapelera?: boolean;
  }): Promise<z.infer<typeof listaDeMensajesSchema>> {
    return this.#llamar('users.messages.list', listaDeMensajesSchema, () =>
      this.#gmail.users.messages.list(
        {
          userId: 'me',
          ...(params.q === undefined ? {} : { q: params.q }),
          ...(params.labelIds === undefined ? {} : { labelIds: params.labelIds }),
          ...(params.maxResults === undefined ? {} : { maxResults: params.maxResults }),
          ...(params.pageToken === undefined ? {} : { pageToken: params.pageToken }),
          ...(params.incluirSpamYPapelera === undefined
            ? {}
            : { includeSpamTrash: params.incluirSpamYPapelera }),
        },
        { timeout: TIMEOUT_MS },
      ),
    );
  }

  /**
   * El hilo completo. Sirve para la pregunta que define varias reglas: ¿este hilo
   * lo empezamos nosotros? Un mail en spam que pertenece a un hilo con un mensaje
   * de MyCompany es una respuesta a una campaña mal clasificada por Gmail. Uno que
   * no, es spam de verdad — y en la casilla hay phishing que se hace pasar por
   * MyCompany, así que la diferencia no es cosmética.
   */
  async obtenerHilo(id: string): Promise<z.infer<typeof hiloSchema>> {
    return this.#llamar('users.threads.get', hiloSchema, () =>
      this.#gmail.users.threads.get(
        { userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] },
        { timeout: TIMEOUT_MS },
      ),
    );
  }

  #verificarEscritura(operacion: string): void {
    if (this.#escrituraHabilitada !== true) {
      throw new Error(
        `Escritura en Gmail deshabilitada: se intentó ${operacion} con un cliente de ` +
          'solo lectura. Se habilita con GMAIL_WRITE_ENABLED=true.',
      );
    }
  }

  /**
   * Agrega y quita etiquetas de un mensaje.
   *
   * Es el mismo endpoint que usa el archivado: sacar del inbox es quitar la
   * etiqueta `INBOX`, nunca borrar.
   */
  async modificarEtiquetas(
    messageId: string,
    cambios: { agregar?: string[]; quitar?: string[] },
  ): Promise<void> {
    this.#verificarEscritura('modificar etiquetas');
    await this.#llamar('modificar etiquetas', mensajeSchema, () =>
      this.#gmail.users.messages.modify(
        {
          userId: 'me',
          id: messageId,
          requestBody: {
            ...(cambios.agregar === undefined ? {} : { addLabelIds: cambios.agregar }),
            ...(cambios.quitar === undefined ? {} : { removeLabelIds: cambios.quitar }),
          },
        },
        { timeout: TIMEOUT_MS },
      ),
    );
  }

  async crearEtiqueta(nombre: string): Promise<{ id: string; name: string }> {
    this.#verificarEscritura('crear etiqueta');
    return this.#llamar('crear etiqueta', etiquetaCreadaSchema, () =>
      this.#gmail.users.labels.create(
        {
          userId: 'me',
          requestBody: {
            name: nombre,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show',
          },
        },
        { timeout: TIMEOUT_MS },
      ),
    );
  }

  /**
   * Crea un draft de respuesta dentro del hilo.
   *
   * **No existe el método para enviarlo** (CLAUDE.md #5). El `threadId` y el
   * `In-Reply-To` son lo que hace que Gmail lo muestre como respuesta al mail
   * original y no como un mensaje suelto.
   */
  async crearDraft(params: {
    threadId: string;
    para: string;
    asunto: string;
    cuerpo: string;
    enRespuestaA?: string | undefined;
  }): Promise<{ id: string }> {
    this.#verificarEscritura('crear draft');

    const cabeceras = [
      `To: ${params.para}`,
      `Subject: ${params.asunto}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      ...(params.enRespuestaA === undefined
        ? []
        : [`In-Reply-To: ${params.enRespuestaA}`, `References: ${params.enRespuestaA}`]),
    ];
    // RFC 5322 pide CRLF entre cabeceras, y una línea vacía antes del cuerpo.
    const CRLF = '\r\n';
    const crudo = `${cabeceras.join(CRLF)}${CRLF}${CRLF}${params.cuerpo}`;

    // base64url: la API lo pide sin padding y con - _ en vez de + /.
    const raw = Buffer.from(crudo, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const creado = await this.#llamar('crear draft', draftCreadoSchema, () =>
      this.#gmail.users.drafts.create(
        { userId: 'me', requestBody: { message: { raw, threadId: params.threadId } } },
        { timeout: TIMEOUT_MS },
      ),
    );
    return { id: creado.id };
  }

  async obtenerMensaje(id: string): Promise<MensajeGmail> {
    return this.#llamar('users.messages.get', mensajeSchema, () =>
      this.#gmail.users.messages.get(
        { userId: 'me', id, format: 'full' },
        { timeout: TIMEOUT_MS },
      ),
    );
  }
}
