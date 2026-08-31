import { NEVER_AUTOMATED, type Category } from '../categories.js';
import { ETIQUETA_DE_REVISION } from '../gmail/etiquetas.js';
import { barreraDe, describir, type Accion, type Decision } from './acciones.js';

/**
 * El executor: **el único lugar donde una acción puede salir hacia afuera**.
 *
 * Los handlers deciden qué hacer; acá se decide si se hace. Que sea el único
 * camino es la invariante de CLAUDE.md #6: si un handler pudiera llamar a Snov
 * por su cuenta, los flags quedarían decorativos.
 *
 * Con los flags apagados —que es el default— nada se ejecuta y todo queda
 * registrado como planeado. Eso es el shadow mode, y es lo que alimenta el log.
 */

export interface Barreras {
  gmailWriteEnabled: boolean;
  externalWriteEnabled: boolean;
  /** Categorías habilitadas para acción automática. Vacío = ninguna. */
  autoCategorias: readonly Category[];
  /**
   * `true` cuando la categoría la eligió **una persona** etiquetando el correo
   * (reproceso por etiqueta), y no el clasificador.
   *
   * Saltea `AUTO_CATEGORIES` y nada más. Esa lista contesta "¿confiamos en el
   * criterio del bot para resolver este mail solo?", y acá el criterio no es del
   * bot: la pregunta no aplica. Es el mismo razonamiento por el que las categorías
   * de `NEVER_AUTOMATED` tampoco dependen de ella.
   *
   * **Los dos flags de escritura siguen valiendo.** Un reproceso en shadow mode
   * registra el delta y no ejecuta nada, igual que todo lo demás: una persona puede
   * corregir un juicio del bot, no puede abrir una barrera etiquetando un mail.
   */
  decidioUnaPersona?: boolean;
}

export type EstadoDeAccion =
  /** Salió de verdad hacia afuera. */
  | 'ejecutada'
  /** Se decidió pero una barrera la frenó. `motivo` dice cuál. */
  | 'planeada'
  /** No sale del sistema (dejar en inbox, revisión). No pasa por barreras. */
  | 'registrada'
  /** Se intentó y el servicio falló. `motivo` trae el error. */
  | 'fallida';

export interface ResultadoDeAccion {
  accion: Accion;
  estado: EstadoDeAccion;
  /** Por qué no se ejecutó. Es lo que se lee en el Sheet cuando algo no pasó. */
  motivo: string;
  descripcion: string;
}

/**
 * Una acción que falló no frena a las que le siguen.
 *
 * El caso concreto: un `NOT_NOW` etiqueta, saca del inbox y sube a una lista de
 * Snov. Si Snov devuelve 500, propagar la excepción dejaría el mail sin etiqueta
 * y sin guardar en la base, y la corrida siguiente lo volvería a intentar entero.
 * Registrar el fallo y seguir deja el mail procesado, la falla visible en el
 * Sheet, y la decisión de reintentar en manos de quien la lee.
 */
/**
 * `SnovClient` y `CrmClient` adjuntan el cuerpo crudo de la respuesta en
 * `.cuerpo` al tirar (hasta 300 caracteres) — es la explicación real de la API,
 * y `.message` solo trae `HTTP <status> en <ruta>`. Sin esto, un error como el
 * 404 de `add-to-do-not-email-list` (agosto 2026) llega al Sheet como
 * "HTTP 404 en add-to-do-not-email-list" sin ningún detalle de qué le faltó al
 * pedido, y la única forma de saber más es ir al servidor a mirar el log.
 */
function mensajeDeError(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  const cuerpo = (error as { cuerpo?: unknown } | null)?.cuerpo;
  const texto = typeof cuerpo === 'string' && cuerpo.trim() !== '' ? `${base}: ${cuerpo}` : base;
  return texto.replace(/\s+/g, ' ').slice(0, 200);
}

export interface ResultadoDeEjecucion {
  categoriaFinal: Category;
  categoriaBase: Category | null;
  resultados: ResultadoDeAccion[];
  /** true si algo quedó pendiente de una persona. */
  necesitaRevision: boolean;
  /** Resumen de una línea, para el log y el Sheet. */
  resumen: string;
}

/**
 * Ejecuta —o registra— las acciones de una decisión.
 *
 * `ejecutar` es opcional: mientras no existan los clientes de escritura, el
 * executor decide igual y marca todo como planeado. Cuando lleguen, se inyectan
 * acá y nada más cambia.
 */
export async function ejecutar(
  decision: Decision,
  barreras: Barreras,
  ejecutor?: (accion: Accion) => Promise<void>,
): Promise<ResultadoDeEjecucion> {
  const bloqueante = decision.acciones.find(
    (a) => a.tipo === 'REVISION_HUMANA' && a.bloqueante,
  );

  // Las categorías de `NEVER_AUTOMATED` no pueden estar en AUTO_CATEGORIES —lo
  // rechaza config.ts al bootear— pero eso no significa que sus acciones deban
  // congelarse para siempre. AUTO_CATEGORIES responde "¿confiamos en el criterio
  // para resolver ESTE mail solo?", y estas categorías ya contestaron que no por
  // otro camino: ninguna se archiva —HOT y TO_MANUAL_SORT se quedan en el inbox
  // por DEJAR_EN_INBOX, que no pasa por ninguna barrera—, así que siempre hay una
  // persona mirando antes de que importe. Negarles también el draft, la etiqueta
  // o el lead del CRM no agrega seguridad: solo los deja sin la ayuda que el SPEC
  // pide (CLAUDE.md #5 — "como máximo se genera un draft para revisión humana",
  // no "nunca se genera nada"). Mismo criterio que ya usa ETIQUETAR_REVISION más
  // abajo, generalizado a las demás acciones de estas categorías.
  const habilitadaPorCategoria =
    barreras.decidioUnaPersona === true ||
    (NEVER_AUTOMATED as readonly Category[]).includes(decision.categoriaFinal) ||
    barreras.autoCategorias.includes(decision.categoriaFinal);

  const resultados: ResultadoDeAccion[] = [];

  for (const accion of decision.acciones) {
    const barrera = barreraDe(accion);
    const descripcion = describir(accion);

    // Lo que no sale del sistema no pasa por ninguna barrera: se registra.
    if (barrera === 'ninguna') {
      resultados.push({ accion, estado: 'registrada', motivo: '', descripcion });
      continue;
    }

    // La marca de revisión es la única acción que **no** frena una revisión
    // bloqueante, y tampoco depende de AUTO_CATEGORIES. No es una decisión
    // automática sobre el mail: es el bot avisando que **no** decidió. Someterla a
    // los mismos cerrojos que frenan las decisiones la haría desaparecer
    // exactamente cuando hace falta — y el mail quedaría en el inbox sin ninguna
    // señal de que alguien tiene que mirarlo.
    //
    // Sigue respetando GMAIL_WRITE_ENABLED: es una escritura en la casilla.
    if (accion.tipo === 'ETIQUETAR_REVISION') {
      if (!barreras.gmailWriteEnabled) {
        resultados.push({
          accion,
          estado: 'planeada',
          motivo: 'GMAIL_WRITE_ENABLED=false',
          descripcion,
        });
        continue;
      }
      if (ejecutor === undefined) {
        resultados.push({
          accion,
          estado: 'planeada',
          motivo: 'no hay cliente de escritura conectado todavía',
          descripcion,
        });
        continue;
      }
      try {
        await ejecutor(accion);
        resultados.push({ accion, estado: 'ejecutada', motivo: '', descripcion });
      } catch (error) {
        resultados.push({ accion, estado: 'fallida', motivo: mensajeDeError(error), descripcion });
      }
      continue;
    }

    // El orden de los motivos importa: se reporta el primero que aplica, y el
    // más informativo va primero. "Snov caído" explica más que "flag apagado".
    let motivo = '';
    if (bloqueante !== undefined && bloqueante.tipo === 'REVISION_HUMANA') {
      motivo = `decide una persona: ${bloqueante.motivo}`;
    } else if (!habilitadaPorCategoria) {
      motivo = `${decision.categoriaFinal} no está en AUTO_CATEGORIES`;
    } else if (barrera === 'gmail' && !barreras.gmailWriteEnabled) {
      motivo = 'GMAIL_WRITE_ENABLED=false';
    } else if (barrera === 'externa' && !barreras.externalWriteEnabled) {
      motivo = 'EXTERNAL_WRITE_ENABLED=false';
    }

    if (motivo !== '') {
      resultados.push({ accion, estado: 'planeada', motivo, descripcion });
      continue;
    }

    if (ejecutor === undefined) {
      resultados.push({
        accion,
        estado: 'planeada',
        motivo: 'no hay cliente de escritura conectado todavía',
        descripcion,
      });
      continue;
    }

    try {
      await ejecutor(accion);
      resultados.push({ accion, estado: 'ejecutada', motivo: '', descripcion });
    } catch (error) {
      resultados.push({ accion, estado: 'fallida', motivo: mensajeDeError(error), descripcion });
    }
  }

  // ── Una falla de ejecución tiene que verse en Gmail, no solo en el Sheet ────
  //
  // `ETIQUETAR_REVISION` lo decide `decidir()`, que corre **antes** de ejecutar:
  // cubre los bloqueos que se saben de antemano (confianza baja, Snov caído),
  // pero no puede saber que una acción va a fallar. Sin esto, una acción que
  // revienta en ejecución deja `needsHumanReview` en la base y `FALLÓ` en el
  // Sheet, y **ninguna marca en la casilla** — el mail ya se archivó y nadie lo
  // extraña. Es exactamente la falla silenciosa que el proyecto evita.
  //
  // El caso que lo motivó (agosto 2026): un `UNSUBSCRIBE` real cuyo etiquetar y
  // archivar salieron bien y la baja en Snov falló con 404. La persona escribió
  // "Pls stop!!!", el mail desapareció del inbox, y siguió en las campañas.
  //
  // No devuelve el mail al inbox —eso sería otra decisión, y el archivado ya
  // salió— pero la etiqueta lo pone en el filtro `BOT - TO CHECK`, que es la
  // cola de trabajo documentada en la guía.
  const huboFallas = resultados.some((r) => r.estado === 'fallida');
  const yaMarcado = resultados.some(
    (r) => r.accion.tipo === 'ETIQUETAR_REVISION' && r.estado === 'ejecutada',
  );

  if (huboFallas && !yaMarcado && barreras.gmailWriteEnabled && ejecutor !== undefined) {
    const marca: Accion = { tipo: 'ETIQUETAR_REVISION', etiqueta: ETIQUETA_DE_REVISION };
    const descripcion = describir(marca);
    try {
      await ejecutor(marca);
      resultados.push({ accion: marca, estado: 'ejecutada', motivo: '', descripcion });
    } catch (error) {
      // Si Gmail es justamente lo que está caído, esto también falla. Queda
      // registrado y no se insiste: el Sheet sigue siendo el respaldo.
      resultados.push({ accion: marca, estado: 'fallida', motivo: mensajeDeError(error), descripcion });
    }
  }

  const ejecutadas = resultados.filter((r) => r.estado === 'ejecutada').length;
  const planeadas = resultados.filter((r) => r.estado === 'planeada').length;
  const fallidas = resultados.filter((r) => r.estado === 'fallida').length;

  return {
    categoriaFinal: decision.categoriaFinal,
    categoriaBase: decision.categoriaBase,
    resultados,
    // Una acción fallida deja el mail pendiente de una persona aunque la
    // clasificación haya sido perfecta: alguien tiene que decidir si reintentar.
    necesitaRevision:
      fallidas > 0 || decision.acciones.some((a) => a.tipo === 'REVISION_HUMANA'),
    resumen:
      `${decision.categoriaFinal}` +
      (decision.categoriaBase === null ? '' : ` (base ${decision.categoriaBase})`) +
      ` — ${ejecutadas} ejecutadas, ${planeadas} planeadas` +
      (fallidas === 0 ? '' : `, ${fallidas} FALLIDAS`),
  };
}
