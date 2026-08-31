import type { Category } from '../categories.js';
import {
  CATEGORIA_DE_ETIQUETA,
  ETIQUETA_TO_MANUAL_SORT,
  ETIQUETAS_SIN_CATEGORIA,
} from '../gmail/etiquetas.js';

/**
 * Reproceso por etiqueta: **la etiqueta que puso una persona es la decisión**.
 *
 * Cuando alguien revisa un correo que el bot resolvió mal —o no se animó a
 * resolver—, le pone la etiqueta correcta más `REPROCESS`, y el worker ejecuta las
 * consecuencias que faltan. No vuelve a clasificar: sería gastar tokens para llegar,
 * en el mejor de los casos, a la misma conclusión que la persona ya escribió, y en el
 * peor a la misma equivocación que ella acaba de corregir.
 *
 * Este módulo es solo la **lectura de las etiquetas**. Las consecuencias siguen
 * saliendo de `decidir()` en `handlers.ts`, con `modo: 'reproceso'`: si el switch de
 * categorías se duplicara acá habría dos fuentes de verdad para "qué hace un
 * NOT_NOW", y la que se olvidaría de actualizar sería siempre ésta.
 */

/** Etiquetas de sistema de Gmail: dicen dónde está el mail, no qué es. */
const SISTEMA = new Set([
  'INBOX',
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'SENT',
  'DRAFT',
  'SPAM',
  'TRASH',
  'CHAT',
]);

function esDeSistema(nombre: string): boolean {
  return SISTEMA.has(nombre.toUpperCase()) || nombre.toUpperCase().startsWith('CATEGORY_');
}

/**
 * `UNSUBSCRIBE` es lo único que se lee como modificador y no como categoría.
 *
 * El motivo es que las combinaciones legítimas existen y son varias: SPEC § 6 pide
 * `REFERRAL` + baja cuando la persona dejó la empresa, y § 8 pide
 * `ASK FOR REFERRAL` + baja siempre. Con `UNSUBSCRIBE` compitiendo como categoría,
 * las dos caerían en la regla de "dos categorías = ambiguo" y el reproceso no haría
 * nada justo en los casos para los que se diseñó.
 *
 * Leerlo como modificador deja además la propiedad que hace todo esto entendible:
 * **la etiqueta `UNSUBSCRIBE` significa una sola cosa en toda la casilla**, aparezca
 * sola o acompañada — esa dirección deja de recibir.
 */
const ETIQUETA_DE_BAJA = 'UNSUBSCRIBE';

export type Interpretacion =
  /** Hay una decisión legible. `daDeBaja` viene de la etiqueta `UNSUBSCRIBE`. */
  | {
      readonly tipo: 'categoria';
      readonly categoria: Category;
      readonly daDeBaja: boolean;
      /** Para el log: qué etiquetas se leyeron para llegar acá. */
      readonly desconocidas: readonly string[];
    }
  /** Ninguna etiqueta dice de qué se trata. No se adivina. */
  | { readonly tipo: 'sin-categoria'; readonly desconocidas: readonly string[] }
  /** Dos o más categorías distintas: no hay forma de saber cuál vale. */
  | { readonly tipo: 'ambigua'; readonly categorias: readonly Category[] };

/**
 * Lee las etiquetas de un mensaje y devuelve la decisión que expresan.
 *
 * La comparación es case-insensitive porque Gmail no admite dos etiquetas que
 * difieran solo en mayúsculas: `mismoNombre()` sigue el mismo criterio.
 *
 * Las etiquetas que no conoce **no bloquean**. Es deliberado: si mañana aparece una
 * etiqueta nueva en la casilla, un reproceso con la categoría bien puesta tiene que
 * seguir funcionando. Se devuelven en `desconocidas` para que queden en el log, que
 * es lo que hace falta para enterarse de que existen.
 */
export function interpretarEtiquetas(nombres: readonly string[]): Interpretacion {
  const conocidas = new Map(
    Object.entries(CATEGORIA_DE_ETIQUETA).map(([n, c]) => [n.toLowerCase(), c]),
  );
  const sinCategoria = new Set(ETIQUETAS_SIN_CATEGORIA.map((n) => n.toLowerCase()));

  const categorias = new Set<Category>();
  const desconocidas: string[] = [];
  let daDeBaja = false;

  for (const crudo of nombres) {
    const nombre = crudo.trim();
    const clave = nombre.toLowerCase();

    if (esDeSistema(nombre)) continue;
    if (clave === ETIQUETA_DE_BAJA.toLowerCase()) {
      daDeBaja = true;
      continue;
    }
    // `REPLIED BEFORE` y sus anidadas: se conocen, y a propósito no son categoría.
    // TO_MANUAL_SORT no tiene ninguna acción externa, así que un reproceso ahí no
    // tendría nada que ejecutar (SPEC.md § 13).
    if (clave === ETIQUETA_TO_MANUAL_SORT.toLowerCase()) continue;
    if (clave.startsWith(`${ETIQUETA_TO_MANUAL_SORT.toLowerCase()}/`)) continue;
    if (sinCategoria.has(clave)) continue;

    const categoria = conocidas.get(clave);
    if (categoria === undefined) {
      desconocidas.push(nombre);
      continue;
    }
    categorias.add(categoria);
  }

  if (categorias.size > 1) {
    return { tipo: 'ambigua', categorias: [...categorias].sort() };
  }

  const unica = [...categorias][0];
  if (unica !== undefined) {
    return { tipo: 'categoria', categoria: unica, daDeBaja, desconocidas };
  }

  // `UNSUBSCRIBE` sola sí es una categoría: "no le escribas más a esta dirección".
  if (daDeBaja) {
    return { tipo: 'categoria', categoria: 'UNSUBSCRIBE', daDeBaja: true, desconocidas };
  }

  return { tipo: 'sin-categoria', desconocidas };
}

/**
 * La huella del conjunto de etiquetas de un mensaje, para el candado anti-loop.
 *
 * El barrido no puede confiar en haber podido quitar `REPROCESS`: en shadow mode no
 * escribe, y con Gmail caído el `modify` falla. Sin candado, el mismo correo se
 * reprocesaría cada diez minutos para siempre.
 *
 * Se guarda la huella y no un booleano porque tiene que distinguir dos cosas: "ya lo
 * hice" y "la persona cambió de idea y lo reetiquetó". Si las etiquetas cambian, la
 * huella cambia y el correo se vuelve a procesar; si son las mismas, se saltea.
 *
 * Ordenada y normalizada para que el orden en que Gmail devuelve las etiquetas no
 * genere huellas distintas del mismo estado.
 */
export function huellaDeEtiquetas(nombres: readonly string[]): string {
  return [...nombres]
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n !== '' && !esDeSistema(n))
    .sort()
    .join('|');
}
