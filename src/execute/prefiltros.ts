import type { Category } from '../categories.js';

/**
 * Prefiltros determinísticos: lo que se resuelve **antes** del clasificador.
 *
 * Son funciones puras sobre el sobre del mensaje (remitente y asunto), sin
 * cuerpo y sin Snov. Existen por dos motivos distintos:
 *
 * - **Costo.** En la casilla real, 49 de cada 50 mensajes que llegan al worker
 *   son correo de calentamiento. Mandarlos al clasificador es gastar tokens y
 *   una llamada a Snov para llegar siempre a la misma conclusión.
 * - **Precisión.** El marcador del asunto es más confiable que el LLM para esto:
 *   sobre esos mismos 49, el clasificador dijo `WARMUP` en 43 y se fue a
 *   `NO_ES_RESPUESTA` u `OTHER` en 6, que además se llevaron toda la cola de
 *   revisión humana de la corrida.
 *
 * Un prefiltro reemplaza al clasificador, **no al executor**: la decisión sigue
 * pasando por `decidir()` y por `ejecutar()`, con las mismas barreras. Si acá se
 * pudiera archivar directo, los flags quedarían decorativos (CLAUDE.md #6).
 */

export type Prefiltro =
  /** No es una respuesta de prospect y no se registra. */
  | { readonly tipo: 'ignorar'; readonly motivo: string }
  /** Categoría resuelta sin clasificador. Sigue por el executor. */
  | { readonly tipo: 'categoria'; readonly categoria: Category; readonly motivo: string };

export interface SobreDelMensaje {
  readonly from: { readonly email: string };
  /** Gmail puede no traer asunto. Sin asunto no hay marcador. */
  readonly subject: string | null;
}

/**
 * Marcadores de calentamiento en el asunto.
 *
 * `[WRM]` va anclado al principio, tolerando cadenas de `Re:`/`Fwd:` porque el
 * calentamiento se responde a sí mismo. El sufijo ` - snv` es el de Snov.io,
 * documentado en SPEC.md § 10.
 *
 * El tercer marcador que menciona el SPEC —el código alfanumérico al final del
 * asunto de Instantly— **no** está acá a propósito: "termina en algo que parece
 * un hash" da falsos positivos sobre asuntos reales, y un falso positivo acá
 * archiva una respuesta de prospect sin que nadie la vea. Si aparece volumen de
 * Instantly, el marcador se define mirando mensajes reales, no adivinando.
 */
const PREFIJOS_DE_RESPUESTA = /^(?:\s*(?:re|fw|fwd|rv)\s*:\s*)*/i;
const MARCADOR_WRM = /^\[wrm\]/i;
const MARCADOR_SNOV = /\s-\ssnv\s*$/i;

export function esAsuntoDeCalentamiento(subject: string | null): boolean {
  if (subject === null) return false;
  const sinPrefijos = subject.replace(PREFIJOS_DE_RESPUESTA, '');
  return MARCADOR_WRM.test(sinPrefijos) || MARCADOR_SNOV.test(subject);
}

function esDireccionPropia(email: string, dominios: readonly string[]): boolean {
  const dominio = email.split('@').at(-1)?.toLowerCase() ?? '';
  return dominios.some((d) => dominio === d.toLowerCase());
}

/**
 * Carpetas de sistema donde el pipeline **no** tiene que actuar.
 *
 * ## Por qué existe: la invariante que no se cumplía
 *
 * `OPERACIONES.md` afirmaba que el worker no ve el correo de Spam, porque
 * `messages.list` lo excluye por default. Eso es cierto **solo del camino por
 * fecha**. El camino normal es `users.history.list`, que reporta *todo* lo que entra
 * al buzón sin importar en qué carpeta cae, y `fetchNewMessages` no filtra por
 * etiqueta a propósito. Así que en producción el pipeline sí clasificaba y sí
 * actuaba sobre mail que Gmail había marcado como spam.
 *
 * Medido en la casilla real (26/8/2026), dos síntomas:
 *
 * - **El visible.** Un `OOO` en Spam se clasificó y se "archivó" — pero archivar es
 *   quitar la etiqueta `INBOX`, y un mensaje en Spam no la tiene: la acción salió
 *   sin efecto. Horas después el barrido de Spam lo rescató, le **agregó** `INBOX`,
 *   y el `procesar()` posterior no hizo nada porque la fila ya existía. El mail
 *   quedó etiquetado y en el inbox para siempre, sin nada que hacer con él.
 * - **El grave.** Un `UNSUBSCRIBE` en Spam se va solo a `do-not-email`, que es la
 *   única acción del sistema sin vuelta atrás — sobre un mensaje que Gmail marcó
 *   como no autenticado. Un "remove me" falsificado suprime un prospect real.
 *
 * `TRASH` va junto con `SPAM` por el mismo motivo: si alguien mandó un mail a la
 * papelera, el bot no tiene por qué etiquetarlo ni actuar sobre él.
 *
 * ## Quién lo puede saltear, y quién no
 *
 * El barrido de Spam **sí** actúa sobre Spam: es su trabajo, y tiene su propia
 * guarda —solo rescata remitentes que están en Snov o en el CRM—. Pero parsea el
 * mensaje **antes** de sacarlo de Spam, así que el `labelIds` que le pasa a
 * `procesar()` todavía dice `SPAM`. Por eso la decisión de saltear esta guarda va
 * por el **origen** de la llamada y no por el snapshot de etiquetas, que para ese
 * camino está viejo por construcción.
 */
const CARPETAS_QUE_BLOQUEAN = ['SPAM', 'TRASH'] as const;

/**
 * El nombre de la carpeta de sistema donde está el mensaje, o `null` si está en un
 * lugar donde el pipeline puede actuar.
 */
export function carpetaQueBloquea(labelIds: readonly string[]): string | null {
  return CARPETAS_QUE_BLOQUEAN.find((c) => labelIds.includes(c)) ?? null;
}

/**
 * Devuelve `null` cuando el mensaje tiene que seguir el camino completo. Ese es
 * el default: un prefiltro se agrega solo con evidencia de la casilla real.
 */
export function prefiltrar(
  m: SobreDelMensaje,
  dominiosPropios: readonly string[],
): Prefiltro | null {
  if (esDireccionPropia(m.from.email, dominiosPropios)) {
    return { tipo: 'ignorar', motivo: 'saliente nuestro, no es respuesta de prospect' };
  }

  if (esAsuntoDeCalentamiento(m.subject)) {
    return { tipo: 'categoria', categoria: 'WARMUP', motivo: 'marcador de calentamiento en el asunto' };
  }

  return null;
}
