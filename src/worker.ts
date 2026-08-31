import { instalarManejadorDeErrores } from './cli-errores.js';
import { getConfig } from './config.js';
import { getDb } from './db.js';
import { Clasificador } from './classify/clasificar.js';
import type { Accion } from './execute/acciones.js';
import { ejecutar } from './execute/executor.js';
import { crearEjecutor } from './execute/ejecutores.js';
import { CRM_SIN_CONSULTAR, decidir, type ContextoDelCrm } from './execute/handlers.js';
import { carpetaQueBloquea, prefiltrar } from './execute/prefiltros.js';
import { normalizarNombre, primerNombre } from './execute/plantillas.js';
import { huellaDeEtiquetas, interpretarEtiquetas } from './execute/reproceso.js';
import { crearClienteAutenticado, preflightDeCredenciales } from './gmail/auth.js';
import { GmailClient } from './gmail/client.js';
import { GmailWriter } from './gmail/escritor.js';
import { fetchNewMessages } from './gmail/fetch.js';
import {
  ETIQUETA_DE_REPROCESO,
  ETIQUETA_DE_RESCATE,
  ETIQUETA_DE_REVISION,
  mismoNombre,
} from './gmail/etiquetas.js';
import { buscarRescatablesEnSpam, origenDe, tocaBarrerSpam } from './gmail/spam.js';
import { parsearMensaje, type MensajeParseado } from './gmail/parse.js';
import { cargarCredencial } from './sheet/credencial.js';
import { SheetClient } from './sheet/cliente.js';
import { SheetLogger } from './sheet/log.js';
import { CrmClient } from './crm/client.js';
import { CrmWriter } from './crm/escritor.js';
import { SnovClient } from './snov/client.js';
import { SnovWriter } from './snov/escritor.js';
import { enriquecerProspect, SIN_PROSPECT, type ListasDeCategoria } from './snov/enriquecer.js';
import { guardarEstadoDeSync, leerEstadoDeSync } from './sync-state.js';

/**
 * El worker.
 *
 * Lee Gmail, enriquece con Snov, clasifica con Claude y decide qué hacer. Con los
 * flags apagados —el default— no escribe nada afuera: registra qué *habría* hecho.
 *
 *   npm run worker            # una corrida y termina
 *   npm run worker -- --loop  # cada POLL_INTERVAL_MINUTES
 */

instalarManejadorDeErrores();

const config = getConfig();
const auth = crearClienteAutenticado(config);
const TOPE_DE_SPAM = 100;

const gmail = new GmailClient(auth, {
  scopeConfigurado: config.GMAIL_SCOPE,
  escrituraHabilitada: config.GMAIL_WRITE_ENABLED,
});

/** `undefined` con el flag apagado, y sin él no se puede etiquetar ni archivar. */
const gmailWriter = GmailWriter.crear(gmail, {
  gmailWriteEnabled: config.GMAIL_WRITE_ENABLED,
});
const snov = new SnovClient({
  clientId: config.SNOV_CLIENT_ID,
  clientSecret: config.SNOV_CLIENT_SECRET,
  apiBase: config.SNOV_API_BASE,
  escrituraHabilitada: config.EXTERNAL_WRITE_ENABLED,
});

/**
 * `undefined` con el flag apagado, y sin él no hay forma de escribir en Snov.
 * La barrera está en el constructor, no en un `if` acá: un `if` se olvida.
 */
const snovWriter = SnovWriter.crear(snov, {
  externalWriteEnabled: config.EXTERNAL_WRITE_ENABLED,
});

const crm = new CrmClient({
  baseUrl: config.CRM_BASE_URL,
  token: config.CRM_SERVICE_TOKEN,
  escrituraHabilitada: config.EXTERNAL_WRITE_ENABLED,
});

const crmWriter = CrmWriter.crear(crm, {
  externalWriteEnabled: config.EXTERNAL_WRITE_ENABLED,
});
const clasificador = new Clasificador({
  apiKey: config.ANTHROPIC_API_KEY,
  modelo: config.ANTHROPIC_MODEL,
});

/**
 * El log del Sheet es opcional y tiene su propio flag. Cuando está apagado, el
 * logger simplemente no existe y el worker no cambia en nada: no hay una rama
 * "con log / sin log" repartida por el código, hay un `?.` en tres lugares.
 */
const sheetLogger =
  config.SHEET_LOG_ENABLED &&
  config.SHEET_LOG_ID !== undefined &&
  config.GOOGLE_SERVICE_ACCOUNT_FILE !== undefined
    ? new SheetLogger(
        new SheetClient(
          cargarCredencial(config.GOOGLE_SERVICE_ACCOUNT_FILE),
          config.SHEET_LOG_ID,
        ),
        {
          gmailWriteEnabled: config.GMAIL_WRITE_ENABLED,
          externalWriteEnabled: config.EXTERNAL_WRITE_ENABLED,
        },
      )
    : undefined;

const LISTAS: ListasDeCategoria = {
  NO_THANKS: config.SNOV_LIST_NO_THANKS,
  NOT_NOW: config.SNOV_LIST_NOT_NOW,
  REFERRAL: config.SNOV_LIST_REFERRALS,
};

/** Los mismos tres que usa la extensión del CRM como `INTERNAL_DOMAINS`. */
const DOMINIOS_PROPIOS = ['mycompany.co', 'mycompany.com', 'mycompany.net'];

/**
 * Normaliza lo que devolvió el LLM, o `undefined` si no devolvió nada usable.
 *
 * El prompt le pide que capitalice, pero eso es una instrucción y no una garantía:
 * normalizar de este lado hace que el resultado no dependa de que la haya seguido.
 */
function normalizarNombreSiHay(nombre: string | null): string | undefined {
  const limpio = nombre?.trim() ?? '';
  return limpio === '' ? undefined : normalizarNombre(limpio);
}

function motivosDeRevision(decision: { acciones: readonly Accion[] }): string[] {
  return decision.acciones
    .filter((a): a is Extract<Accion, { tipo: 'REVISION_HUMANA' }> => a.tipo === 'REVISION_HUMANA')
    .map((a) => a.motivo);
}

/** Qué le pasó a un mensaje. Es lo que cuenta la fila de corrida del Sheet. */
type Desenlace = 'ya-procesado' | 'saliente' | 'calentamiento' | 'clasificado' | 'en-spam';

interface Paso {
  readonly desenlace: Desenlace;
  /** Acciones que efectivamente salieron. Se cuenta, no se asume. */
  readonly ejecutadas: number;
}

/**
 * De dónde viene el mensaje, y es lo que decide si se puede actuar sobre Spam.
 *
 * `'rescate'` es el barrido de Spam, que **ya sacó el mensaje de Spam** cuando llama
 * acá: su `labelIds` viene del parseo anterior al rescate, así que mirarlo daría
 * `SPAM` y la guarda mataría justo el camino que sí tiene derecho a actuar.
 */
type Origen = 'inbox' | 'rescate';

async function procesar(m: MensajeParseado, origen: Origen = 'inbox'): Promise<Paso> {
  const db = await getDb();

  // Idempotencia: la PK es el messageId. Reprocesar un rango no repite nada
  // (CLAUDE.md), y esto ahorra la llamada al clasificador, que es la que cuesta.
  if (await db.emailTriage.findUnique({ where: { gmailMessageId: m.messageId } })) {
    return { desenlace: 'ya-procesado', ejecutadas: 0 };
  }

  // Spam y papelera no pasan por el pipeline. `history.list` —el camino normal—
  // trae todo lo que entra al buzón sin filtrar por carpeta, así que sin esto el
  // bot etiqueta y actúa sobre correo que Gmail marcó como spam. Ver el comentario
  // largo en `prefiltros.ts`: el síntoma visible era un mail rescatado que quedaba
  // en el inbox para siempre, y el grave un do-not-email automático sobre un
  // mensaje no autenticado.
  //
  // **No se registra fila.** Es deliberado: la fila es lo que después hace que el
  // rescate no haga nada. Sin fila, cuando el barrido lo rescate va a ser la
  // primera vez que se clasifica, y ahí sí se archiva bien.
  if (origen === 'inbox') {
    const carpeta = carpetaQueBloquea(m.labelIds);
    if (carpeta !== null) {
      console.log(`  ${m.from.email.padEnd(38)} está en ${carpeta}: no lo toca el pipeline`);
      return { desenlace: 'en-spam', ejecutadas: 0 };
    }
  }

  // Lo que se resuelve por el sobre, antes de gastar un token y una llamada a
  // Snov. En la casilla real esto es la mayoría del volumen.
  const previo = prefiltrar(m, DOMINIOS_PROPIOS);
  if (previo?.tipo === 'ignorar') {
    console.log(`  ${m.from.email.padEnd(38)} ${previo.motivo}`);
    return { desenlace: 'saliente', ejecutadas: 0 };
  }

  // Snov primero: si falla, el mail va a revisión humana igual, pero clasificamos
  // para que la cola muestre de qué se trata. Un prefiltrado no lo necesita: ya
  // sabemos que no es un prospect respondiendo.
  let enriquecimiento = SIN_PROSPECT;
  let disponible = true;
  if (previo === null) {
    try {
      enriquecimiento = await enriquecerProspect(snov, m.from.email);
    } catch (e) {
      disponible = false;
      console.error(`  Snov falló para ${m.from.email}: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  // Confianza 1 cuando lo resolvió el prefiltro: no es una estimación del LLM,
  // es un marcador literal en el asunto. Ponerle menos lo mandaría a revisión.
  // El CRM responde "¿ya lo tenemos cargado?", que es una pregunta distinta de la
  // de Snov ("¿le escribimos?"). Sirve para contrastar lo que dijo el clasificador.
  // Un mail prefiltrado no lo necesita: ya sabemos que no es una persona.
  let crmCtx: ContextoDelCrm = CRM_SIN_CONSULTAR;
  if (previo === null && config.CRM_SERVICE_TOKEN !== undefined) {
    try {
      const c = await crm.buscarPorEmail(m.from.email);
      crmCtx = {
        existe: c.exists,
        ...(c.campaignInfo?.statusText === undefined
          ? {}
          : { campana: c.campaignInfo.statusText }),
      };
    } catch (e) {
      // `existe: null` ya dice "no se pudo consultar", que es distinto de "no está".
      console.error(`  CRM falló para ${m.from.email}: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  const salida =
    previo === null
      ? await clasificador.clasificar({
          from: m.from.email,
          nombreDelRemitente: m.from.nombre,
          subject: m.subject,
          cuerpo: m.cuerpo,
        })
      : {
          categoria: previo.categoria,
          confianza: 1,
          // Forma completa y no `{}`: así `salida.entidades.emailNuevo` es válido
          // en los dos caminos sin castear, y un prefiltrado nunca trae entidades
          // reales porque no pasó por el clasificador.
          entidades: {
            referidoNombre: null,
            referidoEmail: null,
            fechaRetorno: null,
            dejoLaEmpresa: false,
            emailNuevo: null,
            primerNombre: null,
          },
        };

  // El nombre de pila, con el heurístico de respaldo. El LLM acierta más porque ve
  // la firma y el cuerpo, no solo el header — pero no siempre corre (un mail
  // prefiltrado no pasa por él) y puede devolver `null`. Resolverlo acá y no en el
  // ejecutor deja un solo lugar donde se decide de dónde sale el nombre.
  const nombreDePila =
    normalizarNombreSiHay(salida.entidades.primerNombre) ?? primerNombre(m.from.nombre);

  const decision = decidir({
    categoria: salida.categoria,
    confianza: salida.confianza,
    emailDelRemitente: m.from.email,
    enriquecimiento,
    enriquecimientoDisponible: disponible,
    listas: LISTAS,
    umbralDeConfianza: config.CONFIDENCE_THRESHOLD,
    dominiosPropios: DOMINIOS_PROPIOS,
    crm: crmCtx,
    emailNuevo: salida.entidades.emailNuevo,
    referidoEmail: salida.entidades.referidoEmail,
    referidoNombre: salida.entidades.referidoNombre,
    dejoLaEmpresa: salida.entidades.dejoLaEmpresa,
  });

  const resultado = await ejecutar(
    decision,
    {
      gmailWriteEnabled: config.GMAIL_WRITE_ENABLED,
      externalWriteEnabled: config.EXTERNAL_WRITE_ENABLED,
      autoCategorias: config.AUTO_CATEGORIES,
    },
    crearEjecutor(
      {
        gmail: gmailWriter,
        snov: snovWriter,
        crm: crmWriter,
        listaDeDoNotEmail: config.SNOV_DO_NOT_EMAIL_LIST,
      },
      {
        emailDelRemitente: m.from.email,
        nombreDelRemitente: m.from.nombre,
        gmailMessageId: m.messageId,
        gmailThreadId: m.threadId,
        asunto: m.subject,
        cuerpo: m.cuerpo,
        ...(nombreDePila === undefined ? {} : { primerNombreDelRemitente: nombreDePila }),
        ...(m.messageIdRfc822 === null ? {} : { messageIdRfc822: m.messageIdRfc822 }),
      },
    ),
  );

  await db.emailTriage.create({
    data: {
      gmailMessageId: m.messageId,
      gmailThreadId: m.threadId,
      fromEmail: m.from.email,
      fromName: m.from.nombre,
      subject: m.subject,
      receivedAt: m.date,
      category: resultado.categoriaFinal,
      categoriaBase: resultado.categoriaBase,
      confidence: salida.confianza,
      entitiesJson: JSON.stringify(salida.entidades),
      needsHumanReview: resultado.necesitaRevision,
      // Todos los motivos, no solo el primero: un mail puede ir a revisión por
      // confianza baja Y por multi-campaña, y quien revisa necesita los dos.
      reviewReason: motivosDeRevision(decision).join(' | ') || null,
      status: 'PENDING',
      gmailWriteEnabled: config.GMAIL_WRITE_ENABLED,
      externalWriteEnabled: config.EXTERNAL_WRITE_ENABLED,
      // Quién decidió la categoría. Un `prefiltro:` acá dice que el mail no pasó
      // por el clasificador, que es lo que explica una confianza de 1.
      classifierModel: previo === null ? config.ANTHROPIC_MODEL : `prefiltro: ${previo.motivo}`,
    },
  });

  console.log(`  ${m.from.email.padEnd(38)} ${resultado.resumen}`);
  for (const r of resultado.resultados) {
    const marca =
      r.estado === 'ejecutada' ? '✓' : r.estado === 'fallida' ? '✗' : r.estado === 'planeada' ? '·' : ' ';
    console.log(`      ${marca} ${r.descripcion}${r.motivo === '' ? '' : `  [${r.motivo}]`}`);
  }

  // El calentamiento no va al Sheet. Son 49 de cada 50 mensajes: llenarían la
  // planilla y enterrarían las respuestas reales, que es lo único que Ally
  // necesita mirar. Quedan contados en la fila de la corrida y en la base.
  if (previo === null) {
    await sheetLogger?.registrarMail({
      messageId: m.messageId,
      fecha: m.date,
      from: m.from.email,
      nombre: m.from.nombre,
      asunto: m.subject,
      cuerpo: m.cuerpo,
      confianza: salida.confianza,
      clasificoPor: config.ANTHROPIC_MODEL,
      resultado,
      motivosDeRevision: motivosDeRevision(decision),
    });
  }

  return {
    desenlace: previo === null ? 'clasificado' : 'calentamiento',
    ejecutadas: resultado.resultados.filter((r) => r.estado === 'ejecutada').length,
  };
}

/**
 * Revisa Spam y devuelve al inbox las respuestas de prospects conocidos.
 *
 * Los rescatados **pasan por el pipeline como cualquier otro mail**: se clasifican
 * y se actúa sobre ellos. Es seguro porque la guarda de `NO_ES_RESPUESTA` ya cubre
 * el caso peligroso — si el clasificador quisiera archivar como ruido a alguien que
 * está en Snov, no lo deja. Y es justamente porque está en Snov que lo rescatamos.
 *
 * Un fallo del barrido no frena la corrida: Spam es un extra, el inbox es el trabajo.
 */
async function barrerSpam(): Promise<number> {
  if (gmailWriter === undefined) {
    console.log('  (spam) GMAIL_WRITE_ENABLED=false: no se puede sacar nada de Spam');
    return 0;
  }

  const resumen = await buscarRescatablesEnSpam({
    gmail,
    snov,
    ...(config.CRM_SERVICE_TOKEN === undefined ? {} : { crm }),
    dominiosPropios: DOMINIOS_PROPIOS,
    tope: TOPE_DE_SPAM,
  });

  console.log(
    `  (spam) ${resumen.revisados} revisados · ${resumen.propios} propios · ` +
      `${resumen.rescatables.length} de prospects conocidos · ${resumen.desconocidos} se quedan`,
  );

  for (const r of resumen.rescatables) {
    await gmailWriter.sacarDeSpam(r.mensaje.messageId, ETIQUETA_DE_RESCATE);
    console.log(`  ↑ ${r.mensaje.from.email.padEnd(36)} rescatado [${origenDe(r)}]`);
    // Y de acá en adelante es un mail más: la misma función que procesa el inbox.
    // El origen va explícito: el mensaje ya salió de Spam, pero su `labelIds` es
    // de antes del rescate y todavía dice SPAM.
    await procesar(r.mensaje, 'rescate');
  }

  return resumen.rescatables.length;
}

/** Tope de intentos antes de dejar de insistir con un mismo reproceso. */
const TOPE_DE_INTENTOS = 5;

/**
 * Reproceso por etiqueta: **lo que dicen las etiquetas que puso una persona**.
 *
 * Es un camino de entrada aparte, y por eso no pasa por `fetchNewMessages`: consulta
 * por etiqueta, así que **no depende del cursor**. Eso es lo que le permite alcanzar
 * un correo que ya salió del inbox y que el cursor dejó atrás hace días, sin el juego
 * de retroceder `lastMessageDate` que hacen los scripts `reprocesar:*`.
 *
 * No llama al clasificador. La etiqueta es la decisión (SPEC.md § Reproceso).
 */
async function barrerReprocesos(): Promise<number> {
  if (gmailWriter === undefined) {
    // Sin poder quitar `REPROCESS` no se puede cerrar el ciclo, y registrar el
    // candado igual sería peor: cuando se habilitara la escritura, el correo ya
    // figuraría como reprocesado y no se volvería a mirar. Se avisa y no se toca nada.
    console.log('  (reproceso) GMAIL_WRITE_ENABLED=false: no se puede quitar la etiqueta, se saltea');
    return 0;
  }

  const { labels } = await gmail.listarEtiquetas();
  const nombrePorId = new Map<string, string>();
  let idDeReproceso: string | undefined;
  for (const l of labels ?? []) {
    if (typeof l.id !== 'string' || typeof l.name !== 'string') continue;
    nombrePorId.set(l.id, l.name);
    if (mismoNombre(l.name, ETIQUETA_DE_REPROCESO)) idDeReproceso = l.id;
  }

  if (idDeReproceso === undefined) {
    console.log(`  (reproceso) la etiqueta "${ETIQUETA_DE_REPROCESO}" no existe en la casilla`);
    return 0;
  }

  const lista = await gmail.listarMensajes({
    labelIds: [idDeReproceso],
    maxResults: config.REPROCESS_MAX_PER_RUN,
  });
  const ids = (lista.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return 0;

  // Gmail etiqueta la **conversación**, no el mensaje: etiquetar un hilo desde la UI
  // deja `REPROCESS` en todos sus mensajes, incluidas las respuestas de Ally. Sin
  // agrupar, un hilo de cuatro mensajes se procesaría cuatro veces, y una de esas
  // trataría a Ally como el prospect. Se queda el entrante más reciente de cada hilo.
  const porHilo = new Map<string, MensajeParseado>();
  for (const id of ids) {
    const m = parsearMensaje(await gmail.obtenerMensaje(id));

    const previo = prefiltrar(m, DOMINIOS_PROPIOS);
    if (previo?.tipo === 'ignorar') continue;

    const carpeta = carpetaQueBloquea(m.labelIds);
    if (carpeta !== null) {
      console.log(`  (reproceso) ${m.from.email} está en ${carpeta}: no se toca`);
      continue;
    }

    const actual = porHilo.get(m.threadId);
    if (actual === undefined || m.date > actual.date) porHilo.set(m.threadId, m);
  }

  let hechos = 0;
  for (const m of porHilo.values()) {
    if (await reprocesarUno(m, nombrePorId, gmailWriter)) hechos += 1;
  }
  return hechos;
}

/** Devuelve `true` si el reproceso llegó a ejecutar la decisión de la persona. */
async function reprocesarUno(
  m: MensajeParseado,
  nombrePorId: Map<string, string>,
  writer: GmailWriter,
): Promise<boolean> {
  const db = await getDb();
  const etiquetas = m.labelIds.map((id) => nombrePorId.get(id)).filter((n): n is string => n !== undefined);
  const huella = huellaDeEtiquetas(etiquetas);
  const fila = await db.emailTriage.findUnique({ where: { gmailMessageId: m.messageId } });

  // ── El candado, y por qué hacen falta dos campos y no uno ──────────────────
  //
  // `reprocesoHuella` es "las etiquetas con las que lo intenté por última vez" y
  // `reprocesadoEn` es "y llegué a terminarlo". Separarlos es lo que permite contar
  // intentos de un reproceso que falla sin marcarlo como hecho.
  //
  // Con un solo campo no cerraba: al fallar no se guardaba la huella —para poder
  // reintentar— y entonces la corrida siguiente no reconocía el intento anterior, el
  // contador volvía a 1 y el tope de intentos no se alcanzaba nunca. Un fallo
  // persistente reintentaba cada diez minutos para siempre.
  const mismasEtiquetas = fila?.reprocesoHuella === huella;

  if (mismasEtiquetas && fila?.reprocesadoEn !== null) {
    // Ya se hizo con exactamente estas etiquetas. Si la persona cambió de idea y
    // reetiquetó, la huella cambia y esto no frena.
    await writer.quitarEtiquetas(m.messageId, [ETIQUETA_DE_REPROCESO]);
    return false;
  }

  const intentos = (mismasEtiquetas ? (fila?.reprocesoIntentos ?? 0) : 0) + 1;
  const interpretacion = interpretarEtiquetas(etiquetas);

  if (interpretacion.tipo !== 'categoria') {
    // No se adivina. Las dos formas de no poder leer la decisión terminan igual: el
    // correo queda a la vista de una persona con el motivo en el log, y se saca
    // `REPROCESS` para no repetir el intento en cada corrida.
    const motivo =
      interpretacion.tipo === 'ambigua'
        ? `dos categorías a la vez (${interpretacion.categorias.join(', ')}): no se puede saber cuál vale`
        : 'ninguna etiqueta dice de qué se trata';
    console.log(`  (reproceso) ${m.from.email.padEnd(34)} ${motivo}`);
    await writer.etiquetar(m.messageId, ETIQUETA_DE_REVISION);
    await writer.quitarEtiquetas(m.messageId, [ETIQUETA_DE_REPROCESO]);
    return false;
  }

  if (interpretacion.desconocidas.length > 0) {
    // No frenan la decisión, pero que una etiqueta nueva de la casilla exista sin
    // que nadie lo sepa es justo lo que hace que estas cosas se descubran tarde.
    console.log(`  (reproceso) etiquetas que no conozco: ${interpretacion.desconocidas.join(', ')}`);
  }

  let enriquecimiento = SIN_PROSPECT;
  let disponible = true;
  try {
    enriquecimiento = await enriquecerProspect(snov, m.from.email);
  } catch (e) {
    disponible = false;
    console.error(`  (reproceso) Snov falló para ${m.from.email}: ${(e as Error).message.slice(0, 80)}`);
  }

  const nombreDePila = primerNombre(m.from.nombre);

  const decision = decidir({
    categoria: interpretacion.categoria,
    // 1 y no una estimación: no la dijo un modelo, la escribió una persona.
    confianza: 1,
    emailDelRemitente: m.from.email,
    enriquecimiento,
    enriquecimientoDisponible: disponible,
    listas: LISTAS,
    umbralDeConfianza: config.CONFIDENCE_THRESHOLD,
    dominiosPropios: DOMINIOS_PROPIOS,
    // El CRM solo alimenta las guardas de NO_ES_RESPUESTA, que el reproceso no
    // aplica: preguntar sería gastar una llamada para un dato que nadie mira.
    crm: CRM_SIN_CONSULTAR,
    // Estas tres las extrae el clasificador del cuerpo, y acá no corrió. Es una
    // limitación real y conocida: un `REFERRAL` por reproceso no tiene de dónde
    // sacar el referido, así que cae en su guarda y va a revisión. Está en el SPEC.
    emailNuevo: null,
    referidoEmail: null,
    referidoNombre: null,
    dejoLaEmpresa: false,
    modo: 'reproceso',
    bajaPedidaPorEtiqueta: interpretacion.daDeBaja,
  });

  const resultado = await ejecutar(
    decision,
    {
      gmailWriteEnabled: config.GMAIL_WRITE_ENABLED,
      externalWriteEnabled: config.EXTERNAL_WRITE_ENABLED,
      autoCategorias: config.AUTO_CATEGORIES,
      decidioUnaPersona: true,
    },
    crearEjecutor(
      {
        gmail: gmailWriter,
        snov: snovWriter,
        crm: crmWriter,
        listaDeDoNotEmail: config.SNOV_DO_NOT_EMAIL_LIST,
      },
      {
        emailDelRemitente: m.from.email,
        nombreDelRemitente: m.from.nombre,
        gmailMessageId: m.messageId,
        gmailThreadId: m.threadId,
        asunto: m.subject,
        cuerpo: m.cuerpo,
        ...(nombreDePila === undefined ? {} : { primerNombreDelRemitente: nombreDePila }),
        ...(m.messageIdRfc822 === null ? {} : { messageIdRfc822: m.messageIdRfc822 }),
      },
    ),
  );

  const fallo = resultado.resultados.some((r) => r.estado === 'fallida');
  const seRinde = fallo && intentos >= TOPE_DE_INTENTOS;

  console.log(`  (reproceso) ${m.from.email.padEnd(34)} ${resultado.resumen}`);
  for (const r of resultado.resultados) {
    const marca = r.estado === 'ejecutada' ? '✓' : r.estado === 'fallida' ? '✗' : '·';
    console.log(`      ${marca} ${r.descripcion}${r.motivo === '' ? '' : `  [${r.motivo}]`}`);
  }

  const datos = {
    gmailThreadId: m.threadId,
    fromEmail: m.from.email,
    fromName: m.from.nombre,
    subject: m.subject,
    receivedAt: m.date,
    category: resultado.categoriaFinal,
    categoriaBase: resultado.categoriaBase,
    confidence: 1,
    needsHumanReview: resultado.necesitaRevision,
    reviewReason: motivosDeRevision(decision).join(' | ') || null,
    status: 'PENDING',
    gmailWriteEnabled: config.GMAIL_WRITE_ENABLED,
    externalWriteEnabled: config.EXTERNAL_WRITE_ENABLED,
    classifierModel: `reproceso: etiquetas de una persona (${etiquetas.join(' + ')})`.slice(0, 300),
    // La huella se guarda **siempre**: es el intento, no el éxito, y es lo que hace
    // que el contador de intentos sobreviva a la corrida siguiente.
    reprocesoHuella: huella,
    reprocesoIntentos: intentos,
    // Ésta es la marca de terminado, y es la que frena el candado. Un fallo la deja
    // en `null` para que se reintente; al agotar los intentos se sella igual, porque
    // seguir insistiendo con algo que falló cinco veces no lo va a arreglar.
    reprocesadoEn: fallo && !seRinde ? null : new Date(),
  };

  await db.emailTriage.upsert({
    where: { gmailMessageId: m.messageId },
    create: { gmailMessageId: m.messageId, entitiesJson: null, ...datos },
    update: datos,
  });

  await sheetLogger?.registrarMail({
    messageId: m.messageId,
    fecha: m.date,
    from: m.from.email,
    nombre: m.from.nombre,
    asunto: m.subject,
    cuerpo: m.cuerpo,
    confianza: 1,
    clasificoPor: 'reproceso (etiqueta humana)',
    resultado,
    motivosDeRevision: motivosDeRevision(decision),
  });

  // ── El cierre del ciclo ────────────────────────────────────────────────────
  // `REPROCESS` se saca siempre que no quede nada por reintentar: es el acuse de
  // recibo, y dejarla puesta haría que el correo se reprocese en cada corrida.
  if (!fallo || seRinde) {
    await writer.quitarEtiquetas(m.messageId, [ETIQUETA_DE_REPROCESO]);
  }

  if (fallo) {
    // Que se vea en la casilla y no solo en el Sheet.
    await writer.etiquetar(m.messageId, ETIQUETA_DE_REVISION);
    if (seRinde) {
      console.error(`  (reproceso) ${m.from.email}: ${intentos} intentos fallidos, no insisto más`);
    }
    return false;
  }

  // Salió todo bien: si el correo estaba en la cola de revisión, ya no lo está.
  // Es lo que evita que `BOT - TO CHECK` se llene de correo resuelto, que es el
  // único problema que esa etiqueta tiene hoy.
  if (!resultado.necesitaRevision) {
    await writer.quitarEtiquetas(m.messageId, [ETIQUETA_DE_REVISION]);
  }

  return true;
}

async function unaCorrida(): Promise<void> {
  const estado = await leerEstadoDeSync();

  // Primero de todo: del otro lado hay una persona que etiquetó un correo y está
  // esperando. Va antes del inbox y antes de Spam.
  if (config.REPROCESS_ENABLED) {
    try {
      const hechos = await barrerReprocesos();
      if (hechos > 0) console.log(`  (reproceso) ${hechos} correo(s) reprocesado(s)`);
    } catch (e) {
      // Mismo criterio que el barrido de Spam: es un camino extra, el inbox es el
      // trabajo. Si falla, se reintenta en la corrida siguiente.
      console.error(`  (reproceso) falló el barrido: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  // Antes del inbox: si hay una respuesta atrapada en Spam, conviene que entre en
  // esta misma corrida y no en la siguiente.
  if (tocaBarrerSpam(estado.lastSpamSweepAt, config.SPAM_SWEEP_HOURS)) {
    try {
      await barrerSpam();
      await guardarEstadoDeSync({ lastSpamSweepAt: new Date() });
    } catch (e) {
      // Spam es un extra; el inbox es el trabajo. Si falla, se reintenta en la
      // corrida siguiente porque el timestamp no se guardó.
      console.error(`  (spam) falló el barrido: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  const { mensajes, cursorPendiente, via, truncadoPorTope, mensajesFantasma } = await fetchNewMessages(gmail, {
    estado,
    maxMensajes: config.MAX_MESSAGES_PER_RUN,
    // Una sola consulta por corrida. Sin esto, el tope se llenaría con mensajes
    // que ya están en la base y el worker no avanzaría nunca.
    sinVer: async (ids) => {
      const db = await getDb();
      const vistos = await db.emailTriage.findMany({
        where: { gmailMessageId: { in: [...ids] } },
        select: { gmailMessageId: true },
      });
      const set = new Set(vistos.map((v) => v.gmailMessageId));
      return ids.filter((id) => !set.has(id));
    },
  });

  console.log(
    `\n[${new Date().toISOString()}] ${mensajes.length} mensajes nuevos (vía ${via})` +
      (truncadoPorTope ? ' — cortado por el tope, el cursor no avanza' : ''),
  );

  if (mensajesFantasma.length > 0) {
    // No es fatal —se saltean y la corrida sigue— pero no es lo esperable: Gmail
    // listó estos ids y después no los tenía. Vale la pena que quede a la vista.
    console.error(`  ${mensajesFantasma.length} mensaje(s) listado(s) pero no encontrado(s) (404), salteados: ${mensajesFantasma.join(', ')}`);
  }

  const cuenta: Record<Desenlace, number> = {
    'ya-procesado': 0,
    saliente: 0,
    calentamiento: 0,
    clasificado: 0,
    'en-spam': 0,
  };
  let ejecutadas = 0;
  for (const m of mensajes) {
    const paso = await procesar(m);
    cuenta[paso.desenlace] += 1;
    ejecutadas += paso.ejecutadas;
  }

  // Va al log y **no** al Sheet a propósito. La pestaña `Corridas` escribe su
  // encabezado solo cuando está vacía, así que sumarle una columna dejaría las filas
  // nuevas con un valor más que el encabezado existente y correría "Modo" —que es la
  // columna que la guía le dice a Ally que mire— a una posición sin título. Si este
  // número tiene que estar en el Sheet, hace falta migrar el encabezado a mano.
  if (cuenta['en-spam'] > 0) {
    console.log(`  ${cuenta['en-spam']} en Spam o papelera: salteados (los mira el barrido, no el pipeline)`);
  }

  const aRevision = await (
    await getDb()
  ).emailTriage.count({ where: { needsHumanReview: true, status: 'PENDING' } });

  await sheetLogger?.registrarCorrida({
    via,
    vistos: mensajes.length,
    calentamiento: cuenta.calentamiento,
    salientes: cuenta.saliente,
    yaProcesados: cuenta['ya-procesado'],
    clasificados: cuenta.clasificado,
    aRevision,
    // Cuántas acciones salieron de verdad. Se suma de los resultados del executor,
    // no se asume: en shadow mode da 0, y que dé 0 es la confirmación de que las
    // barreras siguen puestas. Un 0 hardcodeado no confirmaría nada.
    ejecutadas,
  });

  // Solo después de procesar todo: si el worker muere a mitad, la corrida
  // siguiente vuelve a traerlos y la PK evita duplicar.
  await guardarEstadoDeSync({
    historyId: cursorPendiente.historyId,
    lastMessageDate: cursorPendiente.lastMessageDate,
  });
}

await preflightDeCredenciales(auth, gmail, config);
await sheetLogger?.preparar();

console.log(
  `worker — Gmail:${gmailWriter === undefined ? 'solo lectura' : 'ESCRIBE'} ` +
    `Externo:${config.EXTERNAL_WRITE_ENABLED ? 'ESCRIBE' : 'solo lectura'} ` +
    `Auto:[${config.AUTO_CATEGORIES.join(',') || 'ninguna'}] ` +
    `Snov:${snovWriter === undefined ? 'solo lectura' : 'ESCRIBE'} ` +
    `CRM:${crmWriter === undefined ? 'solo lectura' : 'ESCRIBE'} ` +
    `Sheet:${sheetLogger === undefined ? 'off' : 'on'}`,
);

if (process.argv.includes('--loop')) {
  for (;;) {
    await unaCorrida();
    await new Promise((r) => setTimeout(r, config.POLL_INTERVAL_MINUTES * 60_000));
  }
} else {
  await unaCorrida();
  console.log('\nCorrida terminada.');
  process.exit(0);
}
