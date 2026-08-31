import type { Category } from '../categories.js';
import type { SnovClient } from './client.js';
import type { CampanaDelProspect, ListaDeSnov, Prospect } from './schemas.js';

/**
 * Enriquecimiento del prospect: lo que Snov sabe y Gmail no.
 *
 * Reparto de responsabilidades (SPEC.md):
 *  - **`lists` decide.** Es el estado que escribe el propio worker, y de ahí sale
 *    la regla de segunda respuesta.
 *  - **`campaigns` cuenta e informa.** Alimenta la regla multi-campaña, que ya no
 *    ejecuta nada: manda a revisión humana con los nombres a la vista.
 */

/** Las de FU no cuentan. Prefijo, no "contiene": hay `… - FU Candidate Campaign (…)`. */
const PREFIJO_FU = /^\s*FU\b/i;

export function esCampanaDeFU(nombre: string): boolean {
  return PREFIJO_FU.test(nombre);
}

/**
 * Campañas que cuentan para el umbral del manual: todas menos las de FU.
 *
 * La exclusión de FU es la que sostiene la regla. Cuando un lead responde y se lo
 * carga en `Leads - Not now Inbox`, después recibe `FU Campaign - Not now`:
 * todo el que alguna vez respondió termina con una comercial + una de FU. Si las de
 * FU contaran, el umbral se dispararía para casi todos los mails que procesa el
 * worker, que son justo respuestas.
 */
export function campanasQueCuentan(campanas: readonly CampanaDelProspect[]): string[] {
  return campanas.map((c) => c.name).filter((n) => !esCampanaDeFU(n));
}

/** IDs de las listas de primera ronda, por categoría. */
export interface ListasDeCategoria {
  NO_THANKS: string;
  NOT_NOW: string;
  REFERRAL: string;
}

/**
 * Cómo se llama en Snov la lista de cada categoría.
 *
 * **Los ids salen del `.env` y estos nombres del código: nada los ata.** Si
 * `SNOV_LIST_NO_THANKS` apuntara a otra lista, el log diría "subir a *No thanks*"
 * mientras el prospect entra a otra — y como cada una tiene una campaña
 * enganchada, empezaría a recibir la secuencia equivocada. La API responde 200
 * igual: es la misma falla silenciosa que casi pasa con do-not-email
 * (SPEC.md § do-not-email).
 *
 * Por eso viven acá y no sueltos en `handlers.ts`: `npm run snov:listas` los
 * contrasta contra `get-user-lists` para que el desajuste se vea antes de que
 * mande un correo.
 */
export const NOMBRE_DE_LISTA: Readonly<Record<keyof ListasDeCategoria, string>> = {
  NO_THANKS: "Leads - No thanks Inbox",
  NOT_NOW: "Leads - Not now Inbox",
  REFERRAL: "Leads - Referrals Inbox",
};

/**
 * ¿El prospect ya está en la lista de primera ronda de su categoría?
 *
 * Es la regla de segunda respuesta: si ya está, la respuesta nueva no va a ninguna
 * lista sino a `TO_MANUAL_SORT` conservando la categoría base.
 */
export function yaEnListaDe(
  listas: readonly ListaDeSnov[],
  categoria: Category,
  ids: ListasDeCategoria,
): boolean {
  // Solo tres categorías tienen lista de primera ronda; el resto nunca es
  // segunda vuelta. El `in` evita castear el objeto a un índice genérico.
  if (!(categoria in ids)) return false;

  const id = ids[categoria as keyof ListasDeCategoria];
  return listas.some((l) => String(l.id) === String(id));
}

export interface Enriquecimiento {
  /** `false` = no es un prospect nuestro. Responde "¿le escribimos alguna vez?". */
  esProspect: boolean;
  nombre: string | null;
  listas: ListaDeSnov[];
  /** Todas las campañas, sin filtrar. Contexto para la cola de revisión. */
  campanas: string[];
  /** Las que cuentan para el umbral del manual. Van con nombre, no solo el número. */
  campanasQueCuentan: string[];
  /** `>= 2` no ejecuta nada: manda a revisión humana (SPEC.md § multi-campaña). */
  multiCampana: boolean;
}

export const SIN_PROSPECT: Enriquecimiento = {
  esProspect: false,
  nombre: null,
  listas: [],
  campanas: [],
  campanasQueCuentan: [],
  multiCampana: false,
};

/**
 * Deriva el enriquecimiento de los prospects ya traídos. Puro: se testea sin red.
 *
 * **Recibe todos los registros, no uno.** `get-prospects-by-email` devuelve un
 * array porque en Snov **la misma dirección puede tener varios perfiles**, uno por
 * lista: es lo que pasa cuando se agrega con `createDuplicates`, que es la única
 * forma que da la API de sumar a una lista a alguien que ya existe en otra.
 *
 * Antes se leía `data[0]` y se ignoraba el resto. Eso escondía justo lo que hay
 * que ver: un prospect sumado a `Not now` seguía apareciendo solo en la lista de
 * su campaña original, así que la regla de segunda respuesta nunca se disparaba y
 * cualquier verificación de "¿quedó en la lista?" daba que no (agosto 2026).
 *
 * Se unen listas y campañas de todos los registros, deduplicando por id: la
 * persona está de verdad en todas ellas.
 */
export function derivarEnriquecimiento(
  prospects: readonly Prospect[] | Prospect | undefined,
): Enriquecimiento {
  const todos =
    prospects === undefined ? [] : Array.isArray(prospects) ? prospects : [prospects];
  if (todos.length === 0) return SIN_PROSPECT;

  const listas = [...new Map(
    todos.flatMap((p) => p.lists ?? []).map((l) => [String(l.id), l]),
  ).values()];

  const campanas = [...new Map(
    todos.flatMap((p) => p.campaigns ?? []).map((c) => [String(c.id), c]),
  ).values()];

  const cuentan = campanasQueCuentan(campanas);

  return {
    esProspect: true,
    nombre: todos.find((p) => p.name != null)?.name ?? null,
    listas,
    campanas: campanas.map((c) => c.name),
    campanasQueCuentan: cuentan,
    multiCampana: cuentan.length >= 2,
  };
}

/**
 * Consulta Snov y deriva el enriquecimiento.
 *
 * **Un fallo de red no se traga.** Si Snov no responde, el llamador tiene que
 * distinguir "no es prospect" de "no pudimos preguntar": lo primero es información,
 * lo segundo obliga a mandar el mail a revisión humana (SPEC.md).
 */
export async function enriquecerProspect(
  client: SnovClient,
  email: string,
): Promise<Enriquecimiento> {
  const respuesta = await client.buscarProspect(email);

  if (!respuesta.success || !respuesta.data || respuesta.data.length === 0) {
    return SIN_PROSPECT;
  }

  return derivarEnriquecimiento(respuesta.data);
}
