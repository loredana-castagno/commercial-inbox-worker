import type { Category } from '../categories.js';

/**
 * Las acciones que el worker puede querer ejecutar sobre un mail.
 *
 * Los handlers **devuelven** acciones; no las ejecutan. Eso los hace funciones
 * puras y testeables sin mocks (CLAUDE.md), y deja un solo lugar —el executor—
 * donde se decide si algo sale de verdad hacia afuera.
 */

export type Accion =
  | { tipo: 'ETIQUETAR'; etiqueta: string }
  /**
   * La etiqueta que dice **"lo miré y no me animé a decidir"**.
   *
   * Es un tipo aparte de `ETIQUETAR` porque no se comporta igual: una revisión
   * bloqueante frena todas las acciones, y si ésta se frenara con las demás
   * desaparecería justo cuando importa. Ver `executor.ts`.
   */
  | { tipo: 'ETIQUETAR_REVISION'; etiqueta: string }
  /** Quitar el label INBOX. **Nunca** delete ni trash (CLAUDE.md #4). */
  | { tipo: 'SACAR_DE_INBOX' }
  /** Explícito y no la ausencia de acción: deja rastro de que fue una decisión. */
  | { tipo: 'DEJAR_EN_INBOX'; motivo: string }
  | {
      tipo: 'SUBIR_A_LISTA_SNOV';
      listaId: string;
      nombreDeLista: string;
      /**
       * Casi siempre se omite: el ejecutor sube al remitente del mail. Se pasa
       * explícito cuando la dirección que hay que sumar **no es la del remitente**:
       * `EMAIL_MODIFIED` subiendo la dirección nueva, y `REFERRAL` subiendo al
       * referido en vez de a quien escribió para decir "no soy yo".
       */
      email?: string;
      /**
       * El nombre que acompaña a esa dirección, cuando tampoco es el del remitente.
       *
       * `EMAIL_MODIFIED` lo omite a propósito —es la misma persona con otra
       * dirección, así que el nombre del remitente sigue siendo el suyo— y
       * `REFERRAL` lo pasa, porque el referido es **otra persona** y subirlo con el
       * nombre de quien escribió deja al prospect con el nombre equivocado en Snov,
       * que es el que después usa el `{{first_name}}` de la campaña.
       */
      nombre?: string;
    }
  | { tipo: 'SUBIR_A_DO_NOT_EMAIL'; email: string }
  | { tipo: 'CREAR_DRAFT'; template: string }
  /**
   * `rating` y `diasDeDueDate` **no viajan al CRM**: `crearContacto()` no tiene
   * dónde ponerlos —el payload de `/api/leads/from-email` solo tiene verificado
   * `email`/`fullName`/`gmailMsgIdDec`/`subject`/`bodyText` (SPEC.md § 9)—, así
   * que quedan solo para el texto del Sheet (`describir()`, más abajo). Calificar
   * el lead como Hot y ponerle vencimiento es un paso que hace Ally a mano en el
   * CRM; es intencional, no una conexión que falta.
   */
  | { tipo: 'CREAR_LEAD_CRM'; rating?: string; diasDeDueDate?: number }
  /**
   * `bloqueante` distingue dos cosas que no son lo mismo:
   *  - **true**: no se pudo decidir bien (confianza baja, Snov caído, multi-campaña,
   *    dirección propia). Las acciones automáticas NO se ejecutan; decide una persona.
   *  - **false**: la categoría siempre se mira, pero la decisión es válida. `HOT`
   *    crea su lead y su draft igual — el draft existe justamente para revisarse.
   */
  | { tipo: 'REVISION_HUMANA'; motivo: string; bloqueante: boolean };

/** Qué barrera gobierna cada acción. */
export type Barrera = 'ninguna' | 'gmail' | 'externa';

/**
 * Subir a una lista de Snov **dispara correos**: la campaña enganchada a esa lista
 * levanta sola lo que aparezca ahí (SPEC.md § Listas y campañas). Por eso pesa
 * igual que el do-not-email y no como un label.
 */
export function barreraDe(accion: Accion): Barrera {
  switch (accion.tipo) {
    case 'ETIQUETAR':
    case 'ETIQUETAR_REVISION':
    case 'SACAR_DE_INBOX':
    case 'CREAR_DRAFT':
      return 'gmail';
    case 'SUBIR_A_LISTA_SNOV':
    case 'SUBIR_A_DO_NOT_EMAIL':
    case 'CREAR_LEAD_CRM':
      return 'externa';
    case 'DEJAR_EN_INBOX':
    case 'REVISION_HUMANA':
      return 'ninguna';
  }
}

/** Una línea legible por humanos. Es lo que va al Sheet y al log. */
export function describir(accion: Accion): string {
  switch (accion.tipo) {
    case 'ETIQUETAR':
      return `etiquetar "${accion.etiqueta}"`;
    case 'ETIQUETAR_REVISION':
      return `marcar "${accion.etiqueta}" para que se vea en Gmail`;
    case 'SACAR_DE_INBOX':
      return 'sacar del inbox';
    case 'DEJAR_EN_INBOX':
      return `dejar en el inbox (${accion.motivo})`;
    case 'SUBIR_A_LISTA_SNOV':
      return accion.email === undefined
        ? `subir a Snov: ${accion.nombreDeLista}`
        : `subir ${accion.email}${accion.nombre === undefined ? '' : ` (${accion.nombre})`} a Snov: ${accion.nombreDeLista}`;
    case 'SUBIR_A_DO_NOT_EMAIL':
      return `subir ${accion.email} a do-not-email`;
    case 'CREAR_DRAFT':
      return `draft con template "${accion.template}"`;
    case 'CREAR_LEAD_CRM':
      return `crear lead en el CRM${accion.rating === undefined ? '' : ` (${accion.rating})`}`;
    case 'REVISION_HUMANA':
      return `REVISIÓN HUMANA: ${accion.motivo}`;
  }
}

export interface Decision {
  /** La que aplica después de las reglas del executor, que puede promover. */
  categoriaFinal: Category;
  /** La que dijo el clasificador, si el executor la cambió. */
  categoriaBase: Category | null;
  acciones: Accion[];
}
