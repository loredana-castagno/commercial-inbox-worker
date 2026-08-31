import type { Category } from '../categories.js';
import { NEVER_AUTOMATED } from '../categories.js';
import type { Enriquecimiento, ListasDeCategoria } from '../snov/enriquecer.js';
import { NOMBRE_DE_LISTA, yaEnListaDe } from '../snov/enriquecer.js';
import {
  ETIQUETA_DE_CATEGORIA,
  ETIQUETA_DE_REVISION,
  etiquetaDeManualSort,
} from '../gmail/etiquetas.js';
import type { Accion, Decision } from './acciones.js';

/**
 * Handlers de categoría: funciones **puras** que traducen una clasificación en
 * una lista de acciones. No ejecutan nada y no conocen los flags.
 *
 * Todas las reglas de negocio del SPEC viven acá, no en el prompt: cambiar a qué
 * lista va un `NO_THANKS` no debería obligar a re-evaluar el clasificador.
 */

/**
 * Lo que el CRM sabe del remitente. Es información que el prompt no ve y que sirve
 * para contrastar lo que dijo el clasificador.
 */
export interface ContextoDelCrm {
  /**
   * Tres estados, y la diferencia importa: `true` existe, `false` no existe,
   * **`null` no se pudo consultar** — que no es lo mismo que "no está".
   */
  readonly existe: boolean | null;
  /** Lo que dice el CRM de su campaña, si está enrolado. Contexto para quien revisa. */
  readonly campana?: string | undefined;
}

export const CRM_SIN_CONSULTAR: ContextoDelCrm = { existe: null };

export interface ContextoDeDecision {
  categoria: Category;
  confianza: number;
  emailDelRemitente: string;
  enriquecimiento: Enriquecimiento;
  /** null cuando no se pudo consultar Snov, que es distinto de "no es prospect". */
  enriquecimientoDisponible: boolean;
  listas: ListasDeCategoria;
  umbralDeConfianza: number;
  /** Dominios propios. Una dirección nuestra jamás va a do-not-email (SPEC.md). */
  dominiosPropios: readonly string[];
  /** Qué sabe el CRM del remitente. `CRM_SIN_CONSULTAR` si no se pudo preguntar. */
  crm: ContextoDelCrm;
  /**
   * La dirección nueva, si `EMAIL_MODIFIED` la extrajo del cuerpo. `null` cuando no
   * aplica o el clasificador no la encontró — las dos cosas se tratan igual acá.
   */
  emailNuevo: string | null;
  /**
   * La dirección del **referido**, si `REFERRAL` la extrajo del cuerpo.
   *
   * Es a quien se sube a la lista de Referrals. No confundir con
   * `emailDelRemitente`: el remitente es el que escribió para decir "no soy yo", y
   * subirlo a esa lista lo pondría en el drip de referidos por haber derivado.
   */
  referidoEmail: string | null;
  /** El nombre del referido. Snov lo necesita para el `{{first_name}}` de la campaña. */
  referidoNombre: string | null;
  /**
   * El remitente avisa que **dejó la empresa**.
   *
   * Es ortogonal a la categoría: puede venir con `REFERRAL` (se fue y deja
   * reemplazo), con `UNSUBSCRIBE` (se fue y no deja nada) o con `OOO` mal
   * clasificado. Acá solo se usa para el caso que el SPEC § 6 pide y que nunca
   * estuvo implementado: un `REFERRAL` de alguien que se fue **además** da de baja
   * la dirección de quien escribió, porque esa casilla no va a volver a contestar.
   */
  dejoLaEmpresa: boolean;
  /**
   * `'reproceso'` cuando la categoría **la decidió una persona** etiquetando el
   * correo, y no el clasificador (SPEC.md § Reproceso por etiqueta).
   *
   * Lo que cambia es exactamente lo que dejó de ser una pregunta abierta:
   *
   * | Se apaga | Por qué |
   * |---|---|
   * | promoción a `TO_MANUAL_SORT` por segunda respuesta | si etiquetó `NOT NOW` sabiendo que ya está en la lista, no hay que corregirla |
   * | guardas de `NO_ES_RESPUESTA` | contrastan al clasificador contra Snov y el CRM; acá no hay clasificador que contrastar |
   * | umbral de confianza y multi-campaña | son "que decida una persona", y decidió |
   * | los borradores | ya tuvo el correo en la mano; si quiere contestar, contesta |
   *
   * **Lo que no cambia son las barreras**: `GMAIL_WRITE_ENABLED`,
   * `EXTERNAL_WRITE_ENABLED`, la prohibición de subir una dirección propia a
   * do-not-email y la de aplicar `TRASH`/`SPAM`. Una persona puede corregir un
   * juicio del bot; no puede desactivar una barrera etiquetando un mail.
   */
  modo?: 'normal' | 'reproceso';
  /**
   * La persona pidió **además** dar de baja la dirección, poniendo la etiqueta
   * `UNSUBSCRIBE` al lado de la de categoría.
   *
   * Solo lo usa el reproceso. Es lo que hace que `REFERRAL` + `UNSUBSCRIBE` y
   * `ASK FOR REFERRAL` + `UNSUBSCRIBE` funcionen sin que `UNSUBSCRIBE` tenga que
   * competir como categoría (ver `reproceso.ts`).
   */
  bajaPedidaPorEtiqueta?: boolean;
}

function esDireccionPropia(email: string, dominios: readonly string[]): boolean {
  const dominio = email.split('@').at(-1)?.toLowerCase() ?? '';
  return dominios.some((d) => dominio === d.toLowerCase());
}

/**
 * Da de baja una dirección de las campañas — o manda a revisión si es nuestra.
 *
 * Existe como función y no repetido en cada `case` porque son ya **cuatro** los
 * caminos que llegan a do-not-email (`UNSUBSCRIBE`, `UNDELIVERABLE`,
 * `EMAIL_MODIFIED` con la dirección vieja, `REFERRAL` de alguien que se fue, y
 * `NOT_RIGHT_CONTACT`), y es la única acción del sistema que no se deshace: la
 * guarda de dominios propios tiene que ser imposible de saltear por olvido, no algo
 * que cada rama se acuerde de escribir (SPEC.md § regla transversal, CLAUDE.md #6).
 *
 * Una dirección nuestra acá mata la campaña que sale desde ese alias, en silencio.
 */
function darDeBaja(
  email: string,
  dominiosPropios: readonly string[],
  acciones: Accion[],
): void {
  if (esDireccionPropia(email, dominiosPropios)) {
    acciones.push({
      tipo: 'REVISION_HUMANA',
      motivo: `${email} es una dirección nuestra: NO va a do-not-email`,
      bloqueante: true,
    });
    return;
  }
  acciones.push({ tipo: 'SUBIR_A_DO_NOT_EMAIL', email });
}

/**
 * `NO_ES_RESPUESTA` pide más confianza que el resto, y el umbral no es negociable
 * con `CONFIDENCE_THRESHOLD` (SPEC.md § 12).
 *
 * El motivo: es la única categoría cuyo error **nadie reporta por definición**. Un
 * `HOT` mal clasificado acá se archiva y nadie lo extraña nunca. Ante la duda, ruido
 * en la cola humana sale mucho más barato que una oportunidad archivada.
 */
const CONFIANZA_MINIMA_NO_ES_RESPUESTA = 0.9;

/**
 * Las categorías que tienen lista de primera ronda y por lo tanto segunda vuelta.
 *
 * **`REFERRAL` no está, y no es un olvido.** La promoción se detecta preguntándole a
 * Snov si el remitente ya está en la lista de primera ronda de su categoría, y a la
 * lista de Referrals va el **referido**, no el remitente: esa dirección no va a
 * aparecer nunca ahí, así que la pregunta no se puede contestar por ese camino.
 *
 * Antes parecía funcionar, pero funcionaba por el bug: el handler subía al remitente
 * a la lista de Referrals, y esa alta equivocada era justamente lo que hacía que la
 * segunda derivación se detectara. Arreglado el alta, el escenario desaparece.
 *
 * En `NO_THANKS` y `NOT_NOW` el remitente **sí** es quien entra a la lista, así que
 * ahí la segunda vuelta es real y sigue igual.
 */
const CON_SEGUNDA_VUELTA = ['NO_THANKS', 'NOT_NOW'] as const;

function esCategoriaConSegundaVuelta(c: Category): c is (typeof CON_SEGUNDA_VUELTA)[number] {
  return (CON_SEGUNDA_VUELTA as readonly string[]).includes(c);
}

/**
 * Identidad de una acción, para poder descartar repetidas.
 *
 * Incluye los argumentos que la hacen distinta —la etiqueta, la lista, la dirección—
 * y no solo el tipo: dos `SUBIR_A_LISTA_SNOV` a listas diferentes son dos acciones
 * legítimas, y `EMAIL_MODIFIED` emite justamente varias.
 */
function huellaDeAccion(a: Accion): string {
  switch (a.tipo) {
    case 'ETIQUETAR':
    case 'ETIQUETAR_REVISION':
      return `${a.tipo}:${a.etiqueta.toLowerCase()}`;
    case 'SUBIR_A_LISTA_SNOV':
      return `${a.tipo}:${a.listaId}:${a.email ?? ''}`;
    case 'SUBIR_A_DO_NOT_EMAIL':
      return `${a.tipo}:${a.email.toLowerCase()}`;
    case 'CREAR_DRAFT':
      return `${a.tipo}:${a.template}`;
    case 'REVISION_HUMANA':
      return `${a.tipo}:${a.motivo}`;
    default:
      return a.tipo;
  }
}

/**
 * Descarta acciones repetidas conservando el orden.
 *
 * Hace falta desde que una decisión puede llegar a la misma acción por dos caminos:
 * un reproceso de `ASK FOR REFERRAL` + `UNSUBSCRIBE` pide la baja por la categoría y
 * por la etiqueta. Sin esto saldrían dos `SUBIR_A_DO_NOT_EMAIL` de la misma dirección
 * — Snov las tolera (el duplicado responde 422 y se lee como `ya-estaba`), pero el
 * log mostraría dos bajas donde hubo una, que es exactamente el tipo de registro que
 * después no se puede auditar.
 */
function sinRepetidas(acciones: readonly Accion[]): Accion[] {
  const vistas = new Set<string>();
  const resultado: Accion[] = [];
  for (const a of acciones) {
    const huella = huellaDeAccion(a);
    if (vistas.has(huella)) continue;
    vistas.add(huella);
    resultado.push(a);
  }
  return resultado;
}

export function decidir(ctx: ContextoDeDecision): Decision {
  const acciones: Accion[] = [];
  let categoria = ctx.categoria;
  let categoriaBase: Category | null = null;

  /** El reproceso ejecuta el veredicto de una persona: los juicios ya están hechos. */
  const esReproceso = ctx.modo === 'reproceso';

  /**
   * Los borradores, que el reproceso no genera.
   *
   * Va como función y no como un `if` en cada `case` por dos razones. Una es que son
   * tres los lugares que generan draft y el cuarto se olvidaría. La otra es más
   * importante: la regla "todo mail con draft se queda en el inbox" se calcula más
   * abajo mirando **si hay una acción `CREAR_DRAFT`**. Si el draft se emitiera igual
   * y se descartara después, esa regla vería un draft que no existe y dejaría el
   * correo en el inbox esperando un borrador que nadie escribió — con `REPROCESS` ya
   * quitado, o sea sin ninguna señal de que hay algo pendiente.
   */
  const draftSiCorresponde = (template: string): void => {
    if (!esReproceso) acciones.push({ tipo: 'CREAR_DRAFT', template });
  };

  // ── Promoción a TO_MANUAL_SORT por segunda respuesta ───────────────────────
  // La decide el executor, no el LLM: el clasificador no puede saber que ya
  // respondió antes (SPEC.md § Segundas respuestas).
  if (
    !esReproceso &&
    esCategoriaConSegundaVuelta(categoria) &&
    ctx.enriquecimientoDisponible &&
    yaEnListaDe(ctx.enriquecimiento.listas, categoria, ctx.listas)
  ) {
    categoriaBase = categoria;
    categoria = 'TO_MANUAL_SORT';
  }

  // ── Las guardas de NO_ES_RESPUESTA (SPEC.md § 12) ──────────────────────────
  // Es la categoría de falla silenciosa, así que no alcanza con lo que dijo el
  // clasificador: se contrasta contra el enriquecimiento, que es información que
  // el prompt no ve.
  if (categoria === 'NO_ES_RESPUESTA' && !esReproceso) {
    // Se pregunta a las dos fuentes: Snov responde "¿le escribimos?" y el CRM
    // "¿lo tenemos cargado?". Alcanza con que una diga que sí.
    const enSnov = ctx.enriquecimiento.esProspect;
    const enCrm = ctx.crm.existe === true;

    if (enSnov || enCrm) {
      // Contradicción dura: el clasificador dice "esto no participa del proceso" y
      // el enriquecimiento dice que la persona ya está en nuestro proceso. Un
      // contacto conocido no es un newsletter, por más List-Unsubscribe que traiga.
      // No se archiva: lo mira una persona.
      const donde = [enSnov ? 'Snov' : null, enCrm ? 'el CRM' : null]
        .filter((x) => x !== null)
        .join(' y ');

      categoria = 'OTHER';
      acciones.push({
        tipo: 'REVISION_HUMANA',
        motivo:
          `lo clasificó como ruido pero el remitente está en ${donde}` +
          (ctx.crm.campana === undefined ? '' : ` — ${ctx.crm.campana}`),
        bloqueante: true,
      });
    } else if (ctx.crm.existe === null) {
      // No se pudo verificar contra el CRM. En cualquier otra categoría daría igual,
      // pero acá el error no deja rastro: sin poder descartar que sea un contacto
      // conocido, no se archiva.
      categoria = 'OTHER';
      acciones.push({
        tipo: 'REVISION_HUMANA',
        motivo: 'no se pudo verificar contra el CRM antes de archivarlo como ruido',
        bloqueante: true,
      });
    } else if (ctx.confianza < CONFIANZA_MINIMA_NO_ES_RESPUESTA) {
      // El umbral normal no alcanza acá: el costo de equivocarse es asimétrico.
      categoria = 'OTHER';
      acciones.push({
        tipo: 'REVISION_HUMANA',
        motivo: `confianza ${ctx.confianza} debajo de ${CONFIANZA_MINIMA_NO_ES_RESPUESTA} para archivar como ruido`,
        bloqueante: true,
      });
    }
  }

  // ── Etiqueta ───────────────────────────────────────────────────────────────
  // El nombre sale de `ETIQUETA_DE_CATEGORIA`, no de la categoría: las etiquetas
  // de Ally se llaman "NO THANKS DRIP", no "NO_THANKS". Emitir la categoría cruda
  // crearía una decena de etiquetas nuevas al lado de las suyas, sin fallar.
  if (categoria === 'TO_MANUAL_SORT') {
    const anidada = etiquetaDeManualSort(categoriaBase);
    if (anidada === null) {
      // La invariante del SPEC: TO_MANUAL_SORT sin categoriaBase no tiene dónde
      // ir. Se prefiere revisión humana antes que la etiqueta padre pelada.
      acciones.push({
        tipo: 'REVISION_HUMANA',
        motivo: 'TO_MANUAL_SORT sin categoría base',
        bloqueante: true,
      });
    } else {
      acciones.push({ tipo: 'ETIQUETAR', etiqueta: anidada });
    }
  } else {
    // La lista vacía es una decisión, no un hueco: hay categorías que no tienen
    // etiqueta en la casilla y no se les inventa una. Y se recorre en vez de tomar
    // la primera porque hay categorías con dos —`NOT_RIGHT_CONTACT` lleva
    // `ASK FOR REFERRAL` y `UNSUBSCRIBE`— y quedarse con una las rompe en silencio.
    for (const etiqueta of ETIQUETA_DE_CATEGORIA[categoria]) {
      acciones.push({ tipo: 'ETIQUETAR', etiqueta });
    }
  }

  // ── Consecuencias por categoría ────────────────────────────────────────────
  switch (categoria) {
    case 'UNSUBSCRIBE':
    case 'UNDELIVERABLE':
      darDeBaja(ctx.emailDelRemitente, ctx.dominiosPropios, acciones);
      break;

    case 'NO_THANKS':
      acciones.push({
        tipo: 'SUBIR_A_LISTA_SNOV',
        listaId: ctx.listas.NO_THANKS,
        nombreDeLista: NOMBRE_DE_LISTA.NO_THANKS,
      });
      break;

    case 'NOT_NOW':
      draftSiCorresponde('Cold last try');
      acciones.push({
        tipo: 'SUBIR_A_LISTA_SNOV',
        listaId: ctx.listas.NOT_NOW,
        nombreDeLista: NOMBRE_DE_LISTA.NOT_NOW,
      });
      break;

    case 'REFERRAL': {
      // **El referido, no el remitente.** Quien escribió dijo "no soy yo": subirlo a
      // la lista de Referrals lo mete en el drip de referidos por haber derivado, y
      // deja al contacto que sí sirve —el único dato nuevo que trajo el mail— sin
      // entrar nunca a Snov. Es lo que hacía el handler hasta agosto de 2026, y no
      // daba ningún síntoma: la API responde 200 igual.
      if (ctx.referidoEmail === null) {
        // Sin dirección no hay a quién subir, y archivar igual perdería el referido
        // en silencio. Misma guarda que `EMAIL_MODIFIED` sin dirección nueva.
        acciones.push({
          tipo: 'REVISION_HUMANA',
          motivo: 'deriva a otra persona pero no se pudo extraer su dirección',
          bloqueante: true,
        });
        break;
      }
      if (esDireccionPropia(ctx.referidoEmail, ctx.dominiosPropios)) {
        // Un referido `@mycompany` es un mail mal leído, no un prospect. Cargarlo
        // metería una dirección nuestra en una campaña nuestra.
        acciones.push({
          tipo: 'REVISION_HUMANA',
          motivo: `el referido ${ctx.referidoEmail} es una dirección nuestra`,
          bloqueante: true,
        });
        break;
      }
      acciones.push({
        tipo: 'SUBIR_A_LISTA_SNOV',
        email: ctx.referidoEmail,
        ...(ctx.referidoNombre === null ? {} : { nombre: ctx.referidoNombre }),
        listaId: ctx.listas.REFERRAL,
        nombreDeLista: NOMBRE_DE_LISTA.REFERRAL,
      });

      // SPEC.md § 6: "si dejó la empresa, además marcar UNSUBSCRIBE para el contacto
      // original". Estaba escrito desde el principio y nunca implementado: la
      // entidad existía, la leía nadie. Es el caso de "ya no trabajo acá, hablá con
      // Chris" — esa casilla no va a volver a contestar, así que sale de las campañas.
      if (ctx.dejoLaEmpresa) {
        for (const etiqueta of ETIQUETA_DE_CATEGORIA.UNSUBSCRIBE) {
          acciones.push({ tipo: 'ETIQUETAR', etiqueta });
        }
        darDeBaja(ctx.emailDelRemitente, ctx.dominiosPropios, acciones);
      }
      break;
    }

    case 'NOT_RIGHT_CONTACT':
      draftSiCorresponde('Ask for referral');
      // La baja de quien escribió, que es lo que la etiqueta `UNSUBSCRIBE` del mapa
      // ya dice en la casilla. Confirmado con Ally (agosto 2026): un "no soy yo
      // quien decide" que no deja a nadie utilizable se desuscribe, y el pedido de
      // referido sale igual — do-not-email suprime las campañas de Snov, no la
      // respuesta que se manda a mano desde Gmail.
      darDeBaja(ctx.emailDelRemitente, ctx.dominiosPropios, acciones);
      break;

    case 'HOT':
      acciones.push({ tipo: 'CREAR_LEAD_CRM', rating: 'Hot', diasDeDueDate: 3 });
      draftSiCorresponde('Position details HOT');
      break;

    case 'EMAIL_MODIFIED':
      // SPEC.md § 7: "reinicia la campaña completa para la dirección nueva". La API
      // de Snov no tiene un endpoint para renombrar un prospect —se probó: no existe
      // ni update ni delete— así que se logra con las dos piezas que sí hay: la
      // dirección nueva entra a cada lista en la que estaba la vieja, y la vieja va
      // a do-not-email para que no le siga llegando nada.
      if (!ctx.enriquecimiento.esProspect) {
        // No es un prospect conocido: no hay nada que migrar. Se archiva con su
        // etiqueta y ya, igual que cualquier categoría sin regla especial.
        break;
      }
      if (ctx.emailNuevo === null) {
        // El clasificador no pudo extraer la dirección nueva del cuerpo. Sin ella no
        // hay a quién migrar, y archivar igual perdería al prospect en silencio —el
        // mismo tipo de falla silenciosa que ya cubren las guardas de
        // NO_ES_RESPUESTA. Se prefiere que lo resuelva una persona.
        acciones.push({
          tipo: 'REVISION_HUMANA',
          motivo: 'avisa que la dirección cambió pero no se pudo extraer la nueva',
          bloqueante: true,
        });
        break;
      }
      for (const lista of ctx.enriquecimiento.listas) {
        acciones.push({
          tipo: 'SUBIR_A_LISTA_SNOV',
          email: ctx.emailNuevo,
          listaId: String(lista.id),
          nombreDeLista: lista.name,
        });
      }
      // Por `darDeBaja` y no directo: es la misma acción irreversible que el resto y
      // le faltaba la guarda de dominios propios. Con el `if` escrito a mano en cada
      // rama, ésta se había quedado sin él y nada lo señalaba.
      darDeBaja(ctx.emailDelRemitente, ctx.dominiosPropios, acciones);
      break;

    default:
      break;
  }

  // ── La baja pedida a mano, con la etiqueta UNSUBSCRIBE ─────────────────────
  //
  // Solo llega desde el reproceso. Va acá y no dentro del switch porque es
  // ortogonal a la categoría: es lo que hace que `REFERRAL` + `UNSUBSCRIBE` y
  // `NOT NOW DRIP` + `UNSUBSCRIBE` signifiquen lo mismo que dice cada etiqueta,
  // sin que `UNSUBSCRIBE` tenga que competir como categoría (ver `reproceso.ts`).
  //
  // La etiqueta ya está puesta —la puso la persona— pero se emite igual: la acción
  // es idempotente en Gmail, y así el log dice qué se leyó de ese correo. El
  // duplicado lo saca el dedup de más abajo cuando la categoría ya la traía.
  if (ctx.bajaPedidaPorEtiqueta === true) {
    for (const etiqueta of ETIQUETA_DE_CATEGORIA.UNSUBSCRIBE) {
      acciones.push({ tipo: 'ETIQUETAR', etiqueta });
    }
    darDeBaja(ctx.emailDelRemitente, ctx.dominiosPropios, acciones);
  }

  // ── Inbox: quién se queda y quién se va ────────────────────────────────────
  //
  // Va **después** del switch a propósito: una de las condiciones es si se
  // generó un draft, y eso recién se sabe acá.
  //
  // **Todo mail con draft se queda en el inbox.** Un borrador es el bot diciendo
  // "preparé algo, decidí vos": archivar el mail deja ese borrador sin contexto y
  // sin nada que recuerde revisarlo — el draft vive en Borradores y el hilo
  // desaparece de la vista. Es la regla que pidió Ally, y se escribe mirando las
  // acciones y no la categoría para que valga sola cuando alguna categoría nueva
  // empiece a generar drafts.
  const dejaDraft = acciones.some((a) => a.tipo === 'CREAR_DRAFT');

  if (
    categoria === 'HOT' ||
    categoria === 'TO_MANUAL_SORT' ||
    categoria === 'NOT_RIGHT_CONTACT' ||
    categoria === 'WEBSITE_CONTACT' ||
    dejaDraft
  ) {
    acciones.push({
      tipo: 'DEJAR_EN_INBOX',
      motivo: dejaDraft ? 'hay un borrador esperando revisión' : 'lo resuelve una persona',
    });
  } else if (categoria !== 'OTHER') {
    acciones.push({ tipo: 'SACAR_DE_INBOX' });
  }

  // ── Ruteo a revisión humana (SPEC.md § Ruteo) ──────────────────────────────
  if ((NEVER_AUTOMATED as readonly string[]).includes(categoria)) {
    // No bloqueante: la decisión es válida, solo que la mira una persona.
    acciones.push({ tipo: 'REVISION_HUMANA', motivo: `${categoria} siempre se revisa`, bloqueante: false });
  }

  // La confianza y el multi-campaña son la misma pregunta con dos formas: "¿esto lo
  // tiene que decidir una persona?". En un reproceso ya la contestó, así que
  // volverlas a aplicar devolvería el correo a la cola de la que acaba de salir.
  if (!esReproceso && ctx.confianza < ctx.umbralDeConfianza) {
    acciones.push({
      tipo: 'REVISION_HUMANA',
      motivo: `confianza ${ctx.confianza} debajo de ${ctx.umbralDeConfianza}`,
      bloqueante: true,
    });
  }

  // Ésta **sí** sigue valiendo en un reproceso, y es la diferencia que importa: no es
  // un juicio, es un dato que falta. Sin Snov, `EMAIL_MODIFIED` no sabe a qué listas
  // migrar y varias reglas quedan sin resolver (SPEC.md), y eso no lo arregla que una
  // persona haya elegido la categoría.
  if (!ctx.enriquecimientoDisponible) {
    acciones.push({ tipo: 'REVISION_HUMANA', motivo: 'no se pudo consultar Snov', bloqueante: true });
  } else if (!esReproceso && ctx.enriquecimiento.multiCampana) {
    acciones.push({
      tipo: 'REVISION_HUMANA',
      motivo: `${ctx.enriquecimiento.campanasQueCuentan.length} campañas comerciales: ${ctx.enriquecimiento.campanasQueCuentan.join(', ')}`,
      bloqueante: true,
    });
  }

  // ── La marca de "no me animé" ────────────────────────────────────────────────
  // Va al final, cuando ya se sabe si algo quedó bloqueado. Cubre los dos casos en
  // que el bot procesa el mail y no hace nada con él:
  //
  //  - una revisión **bloqueante**: confianza baja, Snov caído, multi-campaña,
  //    dirección propia. Decidió no decidir.
  //  - `OTHER`: no entendió de qué se trata, y por eso no lleva etiqueta propia.
  //
  // Sin esto los dos casos se ven en Gmail igual que un mail que el worker nunca
  // miró, y la diferencia importa: uno espera al bot y el otro espera a una persona.
  const hayBloqueo = acciones.some((a) => a.tipo === 'REVISION_HUMANA' && a.bloqueante);
  if (hayBloqueo || categoria === 'OTHER') {
    acciones.push({ tipo: 'ETIQUETAR_REVISION', etiqueta: ETIQUETA_DE_REVISION });
  }

  return { categoriaFinal: categoria, categoriaBase, acciones: sinRepetidas(acciones) };
}
