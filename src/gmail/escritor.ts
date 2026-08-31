import type { GmailClient } from './client.js';
import { ancestrosDe, mismoNombre } from './etiquetas.js';

/**
 * Las escrituras en Gmail: etiquetar, sacar del inbox y crear drafts.
 *
 * ## Todo lo que el bot toca queda leído
 *
 * Cada operación quita `UNREAD` junto con lo suyo, y no cuesta una llamada extra:
 * va en el mismo `modify`.
 *
 * La razón no es cosmética, es que **le da significado a "sin leer"**:
 *
 * | Estado | Qué significa |
 * |---|---|
 * | leído | el bot ya lo miró |
 * | **sin leer** | **el bot todavía no llegó** |
 *
 * Antes era ambiguo —podía ser cualquiera de las dos— y por eso no servía para
 * nada. Ahora "lo que necesita una persona" lo dice la etiqueta (`HOT`,
 * `BOT - TO CHECK`), que además es más específica que la negrita.
 *
 * Y aparece una señal de salud gratis: **si el worker se cae, el correo se acumula
 * sin leer en el inbox.** Antes eso era indistinguible de lo que había dejado a
 * propósito; ahora se ve sin abrir el Sheet.
 *
 * ## Las barreras
 *
 * `GmailWriter` no se puede construir sin la barrera —constructor privado, único
 * camino `crear()`— igual que `SnovWriter` y `CrmWriter`.
 *
 * **Nunca borra.** No hay método que borre ni que mande a la papelera, y no es
 * solo por omisión: mirá `ETIQUETAS_PROHIBIDAS` más abajo.
 */

export interface BarreraDeEscrituraGmail {
  readonly gmailWriteEnabled: boolean;
}

/**
 * En Gmail, la papelera y el spam **son etiquetas**.
 *
 * Eso significa que `users.messages.modify` —el mismo endpoint que aplica
 * `NO THANKS DRIP`— puede borrar un mail con `addLabelIds: ['TRASH']`. La regla 4
 * de CLAUDE.md prohíbe `messages.delete` y `.trash`, pero no alcanza con no
 * llamarlos: el agujero queda abierto por la puerta de al lado.
 *
 * Por eso se rechazan por nombre acá, antes de la llamada. Un mail mal
 * clasificado se desetiqueta en dos clics; uno en la papelera se pierde a los 30
 * días y nadie se entera.
 */
const ETIQUETAS_PROHIBIDAS = ['TRASH', 'SPAM'] as const;

function verificarQueNoBorre(etiquetas: readonly string[], operacion: string): void {
  for (const e of etiquetas) {
    if ((ETIQUETAS_PROHIBIDAS as readonly string[]).includes(e.toUpperCase())) {
      throw new Error(
        `${operacion} intentó aplicar la etiqueta "${e}". En Gmail TRASH y SPAM son ` +
          'etiquetas, así que esto borraría el mail. Este worker nunca borra (CLAUDE.md #4).',
      );
    }
  }
}

export class GmailWriter {
  readonly #cliente: GmailClient;
  /** Nombre → id, cacheado por corrida. Las etiquetas casi no cambian. */
  #cache: Map<string, string> | undefined;

  private constructor(cliente: GmailClient) {
    this.#cliente = cliente;
  }

  static crear(cliente: GmailClient, barrera: BarreraDeEscrituraGmail): GmailWriter | undefined {
    return barrera.gmailWriteEnabled ? new GmailWriter(cliente) : undefined;
  }

  async #etiquetasExistentes(): Promise<Map<string, string>> {
    if (this.#cache !== undefined) return this.#cache;

    const { labels } = await this.#cliente.listarEtiquetas();
    const mapa = new Map<string, string>();
    for (const l of labels ?? []) {
      if (typeof l.name === 'string' && typeof l.id === 'string') {
        mapa.set(l.name.trim().toLowerCase(), l.id);
      }
    }
    this.#cache = mapa;
    return mapa;
  }

  /**
   * Id de la etiqueta, creándola si no existe.
   *
   * La búsqueda es case-insensitive porque Gmail no admite dos etiquetas que
   * difieran solo en mayúsculas: comparar exacto intentaría crear una duplicada.
   *
   * Para las anidadas asegura primero los padres. `REPLIED BEFORE/No thanks` sin `REPLIED BEFORE`
   * queda como una etiqueta huérfana con una barra en el nombre.
   */
  async idDeEtiqueta(nombre: string): Promise<string> {
    const existentes = await this.#etiquetasExistentes();
    const clave = nombre.trim().toLowerCase();

    const yaEsta = existentes.get(clave);
    if (yaEsta !== undefined) return yaEsta;

    for (const ancestro of ancestrosDe(nombre)) {
      if (!existentes.has(ancestro.trim().toLowerCase())) await this.#crear(ancestro);
    }

    return this.#crear(nombre);
  }

  async #crear(nombre: string): Promise<string> {
    const creada = await this.#cliente.crearEtiqueta(nombre);
    const existentes = await this.#etiquetasExistentes();
    existentes.set(nombre.trim().toLowerCase(), creada.id);
    return creada.id;
  }

  /** Aplica una etiqueta por nombre. La crea si hace falta, y marca el mail leído. */
  async etiquetar(messageId: string, nombre: string): Promise<void> {
    verificarQueNoBorre([nombre], 'etiquetar');
    const id = await this.idDeEtiqueta(nombre);
    await this.#cliente.modificarEtiquetas(messageId, { agregar: [id], quitar: ['UNREAD'] });
  }

  /**
   * Quita etiquetas por nombre. Las que no existen en la casilla se ignoran.
   *
   * Es la primera operación del worker que **quita** una etiqueta que no es de
   * sistema, y existe para cerrar el ciclo del reproceso: `REPROCESS` la pone una
   * persona y la tiene que sacar el bot, porque si queda puesta el correo se
   * reprocesa en cada corrida para siempre.
   *
   * **No crea nada.** Al contrario que `etiquetar()`, que crea la etiqueta si falta,
   * acá una etiqueta inexistente simplemente no está en el mensaje: crearla para
   * después quitarla sería agregar vocabulario a la casilla por un no-op.
   *
   * No toca `UNREAD`: quitar una etiqueta no es "el bot lo miró", eso ya lo dijo la
   * operación que lo hizo.
   */
  async quitarEtiquetas(messageId: string, nombres: readonly string[]): Promise<void> {
    const existentes = await this.#etiquetasExistentes();
    const ids = nombres
      .map((n) => existentes.get(n.trim().toLowerCase()))
      .filter((id): id is string => id !== undefined);

    if (ids.length === 0) return;
    await this.#cliente.modificarEtiquetas(messageId, { quitar: ids });
  }

  /**
   * Saca el mail del inbox y lo marca como leído.
   *
   * **Esto es archivar, no borrar.** Es lo que dice el manual y lo que hace Ally a
   * mano: el mail sigue existiendo, sigue buscándose y sigue teniendo sus otras
   * etiquetas. Volver a ponerlo en el inbox es un clic.
   *
   * `UNREAD` es una etiqueta de sistema como `INBOX`, así que se quita igual.
   */
  async sacarDelInbox(messageId: string): Promise<void> {
    await this.#cliente.modificarEtiquetas(messageId, { quitar: ['INBOX', 'UNREAD'] });
  }

  /**
   * Saca un mail de Spam y lo devuelve al inbox.
   *
   * Es la operación **inversa** a la que `ETIQUETAS_PROHIBIDAS` bloquea, y por eso
   * está permitida: no se puede *mandar* nada a Spam ni a la papelera, pero sacar
   * algo de ahí solo puede mejorar la situación. Un rescate equivocado deja un mail
   * de más en el inbox; el error opuesto pierde una respuesta de un prospect.
   *
   * Quitar `SPAM` sin agregar `INBOX` dejaría el mail en el limbo: fuera de Spam
   * pero sin aparecer en ningún lado.
   */
  async sacarDeSpam(messageId: string, etiqueta: string): Promise<void> {
    verificarQueNoBorre([etiqueta], 'rescatar de spam');
    const id = await this.idDeEtiqueta(etiqueta);
    await this.#cliente.modificarEtiquetas(messageId, {
      agregar: ['INBOX', id],
      quitar: ['SPAM', 'UNREAD'],
    });
  }

  /**
   * Crea un **draft**, nunca envía.
   *
   * Es la regla 5 de CLAUDE.md y no tiene excepción: no existe un método que
   * mande un mail en este código. Un draft mal generado lo borra una persona; uno
   * enviado ya salió.
   */
  async crearDraft(params: {
    readonly threadId: string;
    readonly para: string;
    readonly asunto: string;
    readonly cuerpo: string;
    readonly enRespuestaA?: string | undefined;
  }): Promise<{ id: string }> {
    return this.#cliente.crearDraft(params);
  }
}
