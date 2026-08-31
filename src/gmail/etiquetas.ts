import type { Category } from '../categories.js';

/**
 * De categoría del SPEC al **nombre real de la etiqueta en la casilla de Ally**.
 *
 * Esta capa existe porque los dos nombres no coinciden, y descubrirlo tarde
 * hubiera sido caro: los handlers emiten `NO_THANKS` y la etiqueta que Ally usa se
 * llama `NO THANKS DRIP`. Sin este mapeo, la primera corrida con
 * `GMAIL_WRITE_ENABLED=true` habría **creado una decena de etiquetas nuevas** al
 * lado de las suyas, con nombres parecidos y contenido repartido entre ambas. No
 * habría fallado nada: habría quedado el inbox desordenado en silencio.
 *
 * Relevado contra la casilla real (agosto 2026), 18 etiquetas propias:
 *
 * ```
 * ADD TO SF                  EMAIL MODIFIED         NOT NOW TWO DRIP
 * ASK FOR REFERRAL           HOT                    OOO
 * BAIRESDEV - Contratos      INSTANTLY              REFERRAL
 * CLUTCH NOT A VENDOR...     NO THANKS DRIP         REPLIED BEFORE
 * COLD (LAST TRY)            NOT A REPLY            REPROCESS
 *                            NOT NOW DRIP           SNOVIO
 *                                                   UNDELIVERABLE
 *                                                   UNSUBSCRIBE
 * ```
 *
 * **Tres etiquetas de la casilla quedan sin usar por ahora:**
 *
 * - `NOT NOW TWO DRIP` — es de las listas de segunda ronda que quedaron en
 *   desuso. Una segunda respuesta hoy va a `REPLIED BEFORE` (SPEC.md § Segundas
 *   respuestas), así que el worker nunca la aplica.
 * - `COLD (LAST TRY)` — la pone Ally a mano cuando manda el último intento. El
 *   worker genera el draft, no decide que se enviaron.
 * - `REPROCESS` — la creó Ally para el reproceso por etiqueta, que **todavía no
 *   está implementado**. La pone una persona y la saca el worker: es la única del
 *   sistema en ese sentido, al revés de `BOT - TO CHECK`.
 *
 * Que no se usen es una decisión tomada, no una omisión: si aparecen mails con
 * esas etiquetas, los puso una persona.
 *
 * **La lista vacía significa "no etiquetar", y es una decisión, no un hueco.** Una
 * categoría sin etiqueta se procesa igual: se archiva o se deja en el inbox según
 * el handler. Inventarle una etiqueta sería crear vocabulario nuevo en la casilla
 * de otra persona.
 *
 * **Y una categoría puede llevar más de una.** `NOT_RIGHT_CONTACT` lleva dos, y por
 * eso el valor es una lista y no un `string | null`: si fuera un string, el día que
 * una categoría necesitara dos, indexar el mapa devolvería una sola y la otra se
 * perdería sin que nada falle. Con una lista, el tipo obliga a recorrerlas.
 */

/**
 * La etiqueta padre de las anidadas de segunda respuesta.
 *
 * Va aparte porque se usa en dos lugares —el mapa de abajo y `etiquetaDeManualSort`,
 * que arma `REPLIED BEFORE/No thanks`— y sacarla del mapa obligaba a indexar una
 * lista para reconstruir un prefijo.
 */
export const ETIQUETA_TO_MANUAL_SORT = 'REPLIED BEFORE';

/**
 * El `Record` completo obliga a que cada categoría nueva del SPEC decida acá qué
 * etiqueta le toca. Si se agrega una a `CATEGORIES` y no se toca esto, no compila
 * — que es exactamente el recordatorio que hace falta.
 */
export const ETIQUETA_DE_CATEGORIA: Record<Category, readonly string[]> = {
  // Coinciden con las de Ally tal cual.
  OOO: ['OOO'],
  UNSUBSCRIBE: ['UNSUBSCRIBE'],
  UNDELIVERABLE: ['UNDELIVERABLE'],
  REFERRAL: ['REFERRAL'],
  HOT: ['HOT'],

  // Los nombres reales llevan sufijo o espacios, no guiones bajos.
  NO_THANKS: ['NO THANKS DRIP'],
  NOT_NOW: ['NOT NOW DRIP'],
  EMAIL_MODIFIED: ['EMAIL MODIFIED'],

  // `REPLIED BEFORE` y no `TO MANUAL SORT`: todas las demás etiquetas nombran **qué
  // es** el correo, y ésa decía **qué hacer con él**. Lo que importa saber al verla
  // en la bandeja es que esa persona ya te había contestado antes.
  TO_MANUAL_SORT: [ETIQUETA_TO_MANUAL_SORT],

  // Calentamiento. Va a `SNOVIO` y **no** a `INSTANTLY`, que es la que parece
  // obvia por el nombre y es la equivocada:
  //
  // | Carpeta     | Marcador                        | Volumen | Último |
  // |-------------|---------------------------------|---------|--------|
  // | `SNOVIO`    | `[WRM]` al principio del asunto | 5.611   | hoy    |
  // | `INSTANTLY` | código alfanum. al final (`TKSSB6E`) | 34.843 | 2024 |
  //
  // Los dos marcadores que detecta el prefiltro —`[WRM]` y el sufijo ` - snv`—
  // son de Snov, así que su carpeta es `SNOVIO`. `INSTANTLY` es de otro proveedor
  // que dejó de mandar en 2024; su marcador sigue sin implementarse (SPEC.md § 10)
  // y si volviera a llegar, caería en el clasificador y terminaría acá con la
  // etiqueta equivocada. Anotado como agujero conocido en vez de adivinado.
  WARMUP: ['SNOVIO'],

  // **Las dos.** "No soy yo quien decide, y no te dejo a nadie" tiene dos partes, y
  // cada etiqueta dice una:
  //
  // - `ASK FOR REFERRAL` nombra qué es el correo y qué se hizo con él: hay un
  //   borrador pidiendo el contacto correcto y el mail se queda en el inbox.
  // - `UNSUBSCRIBE` nombra la consecuencia: esa dirección deja de recibir.
  //
  // Antes esta categoría llevaba solo `UNSUBSCRIBE`, compartida con la categoría
  // `UNSUBSCRIBE`, y eso hacía que la etiqueta significara **dos cosas distintas**
  // según dónde apareciera el mail —archivado era una baja, en el inbox con
  // borrador era un "no soy yo"—. Con `ASK FOR REFERRAL` aparte, `UNSUBSCRIBE`
  // significa **siempre** lo mismo en toda la casilla: esta dirección no recibe
  // más. Ally creó la etiqueta en agosto de 2026 para esto.
  NOT_RIGHT_CONTACT: ['ASK FOR REFERRAL', 'UNSUBSCRIBE'],

  // Estas dos se archivan, así que sin etiqueta desaparecerían del inbox sin dejar
  // rastro. Y son justo las que hay que poder auditar:
  //
  // - `NOT A REPLY` es la categoría cuyo error **nadie reporta por definición**: un
  //   HOT mal clasificado acá se archiva y nadie lo extraña. Con etiqueta se puede
  //   pasar la vista por la lista de asuntos desde Gmail; sin ella hay que ir al
  //   Sheet columna por columna.
  // - `WEBSITE CONTACT` genera consecuencias reales —contacto en el CRM y alta en
  //   una lista de Snov— y sin etiqueta no quedaba ni una marca en la casilla de
  //   que eso pasó.
  NO_ES_RESPUESTA: ['NOT A REPLY'],

  // Sin etiqueta: estos mails llegan desde @mycompany y el prefiltro de dominios
  // propios los descarta antes de que el bot los toque. Quedan en el inbox como
  // llegaron y los resuelve una persona (SPEC.md § 11).
  WEBSITE_CONTACT: [],

  // OTHER es "no sé": ponerle etiqueta de categoría le daría una certeza que no
  // tiene. Lleva `BOT - TO CHECK`, que es lo que realmente pasó.
  OTHER: [],
};

/**
 * La etiqueta que marca **"el bot lo procesó y no se animó a decidir"**.
 *
 * Sin esto, la incertidumbre del bot es invisible en Gmail: un mail que dejó sin
 * tocar por confianza baja se ve idéntico a uno que nunca miró. La diferencia solo
 * existía en el Sheet, y para verla había que ir a buscarla.
 *
 * Sigue la convención de nombres de la casilla (`BAIRESDEV - Contratos`), y el
 * prefijo `BOT - ` deja claro quién la puso: son las dos únicas etiquetas que
 * inventa este proyecto, todas las demás ya existían.
 */
export const ETIQUETA_DE_REVISION = 'BOT - TO CHECK';

/**
 * La etiqueta de los mails que el bot sacó de Spam.
 *
 * Va aparte de `BOT - TO CHECK` porque el motivo es distinto y el riesgo también:
 * un mail rescatado **estuvo marcado como spam por Gmail**, así que merece una
 * mirada más atenta que uno que simplemente dejó dudando al clasificador.
 */
export const ETIQUETA_DE_RESCATE = 'BOT - RESCUED FROM SPAM';

/**
 * Sub-etiquetas anidadas de `REPLIED BEFORE`, para conservar **qué había contestado
 * esa persona la primera vez** (SPEC.md § 13).
 *
 * Es lo que hace útil la etiqueta padre: `REPLIED BEFORE/No thanks` dice de un
 * vistazo con qué te vas a encontrar sin abrir el mail.
 *
 * Son las que pidió Ally y las únicas que este worker crearía. Es distinto de crear
 * `NO_THANKS` al lado de `NO THANKS DRIP` — acá el vocabulario nuevo es el pedido,
 * no un accidente.
 *
 * **Dos de las cuatro no se alcanzan hoy, y son dos casos distintos:**
 *
 * - `/Referral` quedó inalcanzable a propósito. La promoción por segunda respuesta
 *   se dispara viendo si el remitente ya está en la lista de primera ronda de su
 *   categoría, y el remitente de un `REFERRAL` **ya no entra a la lista de
 *   Referrals**: ahí va el referido. Ver el comentario de `CON_SEGUNDA_VUELTA` en
 *   `handlers.ts`.
 * - `/Hot` es un agujero conocido, no una decisión. `TO_MANUAL_SORT` bajando de
 *   `HOT` lo decide el clasificador, y por ese camino `categoriaBase` llega en
 *   `null`, así que el mail va a revisión sin sub-etiqueta. Anotado en SPEC.md § 13.
 */
export const SUBETIQUETA_TO_SORT: Partial<Record<Category, string>> = {
  NO_THANKS: 'No thanks',
  NOT_NOW: 'Not now',
  REFERRAL: 'Referral',
  HOT: 'Hot',
};

/** El nombre completo de la sub-etiqueta anidada, o `null` si no corresponde. */
export function etiquetaDeManualSort(categoriaBase: Category | null): string | null {
  if (categoriaBase === null) return null;
  const hijo = SUBETIQUETA_TO_SORT[categoriaBase];
  return hijo === undefined ? null : `${ETIQUETA_TO_MANUAL_SORT}/${hijo}`;
}

/**
 * La etiqueta que una **persona** pone para pedir que el worker vuelva a mirar un
 * correo y ejecute lo que corresponda.
 *
 * Es la única etiqueta del sistema en ese sentido —la pone una persona y la saca el
 * bot— y por eso no lleva el prefijo `BOT - `: ese prefijo significa "la puso el
 * bot". `BOT - TO CHECK` es exactamente al revés (la pone el bot, la saca una
 * persona), y las dos juntas son el canal en los dos sentidos.
 *
 * Ally la creó en la casilla en agosto de 2026.
 */
export const ETIQUETA_DE_REPROCESO = 'REPROCESS';

/**
 * De **nombre de etiqueta de la casilla** a categoría del SPEC. El camino inverso de
 * `ETIQUETA_DE_CATEGORIA`, para el reproceso: cuando una persona etiqueta un correo
 * y pide reprocesarlo, la etiqueta **es** la decisión y no hace falta el clasificador.
 *
 * **No es el inverso mecánico del otro mapa, y por eso se escribe a mano.** Dos
 * cosas no se pueden derivar:
 *
 * - `UNSUBSCRIBE` no está acá. No es una categoría en este mapa sino un
 *   **modificador**: al lado de otra etiqueta significa "y además dá de baja la
 *   dirección" (ver `interpretarEtiquetas`). Sola sí resuelve a `UNSUBSCRIBE`, y eso
 *   se maneja aparte para que la etiqueta signifique una sola cosa en los dos casos.
 * - `SNOVIO` resuelve a `WARMUP`, o sea "esto es ruido de calentamiento, archivalo".
 *   Es raro que alguien lo etiquete a mano, pero si lo hace la intención es clara.
 *
 * Las anidadas de `REPLIED BEFORE/` no están: `TO_MANUAL_SORT` no tiene ninguna
 * acción externa (SPEC.md § 13), así que un reproceso ahí no tendría nada que
 * ejecutar. Si alguien las etiqueta, el reproceso no encuentra categoría y el correo
 * queda a la vista en vez de fingir que hizo algo.
 */
export const CATEGORIA_DE_ETIQUETA: Readonly<Record<string, Category>> = {
  OOO: 'OOO',
  UNDELIVERABLE: 'UNDELIVERABLE',
  REFERRAL: 'REFERRAL',
  HOT: 'HOT',
  'NO THANKS DRIP': 'NO_THANKS',
  'NOT NOW DRIP': 'NOT_NOW',
  'EMAIL MODIFIED': 'EMAIL_MODIFIED',
  'ASK FOR REFERRAL': 'NOT_RIGHT_CONTACT',
  'NOT A REPLY': 'NO_ES_RESPUESTA',
  SNOVIO: 'WARMUP',
};

/**
 * Etiquetas de la casilla que **no** son categorías, listadas explícitamente.
 *
 * La lista existe para que el reproceso pueda distinguir "esta etiqueta no dice nada
 * sobre la categoría" de "esta etiqueta es nueva y no sé qué significa". Sin ella, un
 * correo con `ADD TO SF` se vería igual que uno sin etiquetas y el bot archivaría
 * pensando que la persona no decidió nada.
 *
 * `COLD (LAST TRY)` y `ADD TO SF` son marcas de trabajo de Ally; `NOT NOW TWO DRIP` e
 * `INSTANTLY` están en desuso; las `BOT - *` y `REPROCESS` son del canal con el bot.
 */
export const ETIQUETAS_SIN_CATEGORIA: readonly string[] = [
  'ADD TO SF',
  'COLD (LAST TRY)',
  'NOT NOW TWO DRIP',
  'INSTANTLY',
  'BAIRESDEV - Contratos',
  'CLUTCH NOT A VENDOR - DO NOT REPLY',
  ETIQUETA_DE_REPROCESO,
  ETIQUETA_DE_REVISION,
  ETIQUETA_DE_RESCATE,
];

/**
 * Gmail no deja convivir dos etiquetas cuyo nombre difiera solo en mayúsculas, así
 * que la búsqueda es case-insensitive. Comparar exacto crearía `no thanks drip` al
 * lado de `NO THANKS DRIP` — o fallaría, según el humor de la API.
 */
export function mismoNombre(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Las etiquetas padre que hay que asegurar antes de crear una anidada.
 * `REPLIED BEFORE/No thanks` necesita que exista `REPLIED BEFORE`.
 */
export function ancestrosDe(nombre: string): string[] {
  const partes = nombre.split('/');
  return partes.slice(0, -1).map((_, i) => partes.slice(0, i + 1).join('/'));
}
