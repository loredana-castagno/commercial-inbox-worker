import 'dotenv/config';
import { instalarManejadorDeErrores } from '../cli-errores.js';
import { getConfig } from '../config.js';
import { getDb } from '../db.js';
import { crearClienteAutenticado } from '../gmail/auth.js';
import { GmailClient } from '../gmail/client.js';
import { parsearMensaje } from '../gmail/parse.js';
import { guardarEstadoDeSync, leerEstadoDeSync } from '../sync-state.js';

/**
 * Borra el registro de triage de los mensajes **que están hoy en el inbox**, para
 * que la corrida siguiente los procese de cero.
 *
 *   npm run reprocesar:inbox              # solo muestra, no toca nada
 *   npm run reprocesar:inbox -- --confirmar
 *
 * ## Por qué existe
 *
 * La clave primaria de `EmailTriage` es el id del mensaje: el worker saltea lo que
 * ya vio. Eso es lo que hace que reprocesar un rango no duplique acciones — pero
 * también significa que un mail clasificado en shadow mode **nunca se vuelve a
 * mirar**, aunque después se habilite la escritura. Este script es la única forma
 * prevista de volver atrás esa decisión.
 *
 * ## Por qué solo el inbox
 *
 * Es la parte importante del diseño, no una limitación. Un "reprocesar" apuntable a
 * un rango arbitrario volvería a ejecutar acciones sobre cientos de correos ya
 * resueltos: subirlos otra vez a listas de Snov, crear notas en el CRM, reetiquetar.
 * El inbox es, por definición, lo que todavía no se resolvió.
 *
 * ## Por qué además retrocede el cursor
 *
 * Borrar la fila no alcanza si el mensaje quedó **fuera de la ventana de fetch**.
 * El worker consulta a Gmail desde `lastMessageDate` en adelante: un mail más viejo
 * que esa fecha no se lista, exista o no su registro. Por eso el script también
 * retrocede el cursor hasta el mensaje más viejo del inbox.
 *
 * **Nunca toca Gmail.** Solo borra filas y mueve el cursor. Los mails no se mueven,
 * no se etiquetan y no se borran: lo único que cambia es que el worker vuelve a
 * considerarlos.
 */

instalarManejadorDeErrores();

/**
 * Tope de seguridad. El inbox de Ally ronda la decena de mensajes; si aparecen
 * cientos es que algo está mal —una etiqueta que se cayó, un archivado masivo— y
 * ese no es el momento de reprocesar a ciegas.
 */
const TOPE = 60;

const confirmar = process.argv.includes('--confirmar');

const config = getConfig();
const gmail = new GmailClient(crearClienteAutenticado(config), {
  scopeConfigurado: config.GMAIL_SCOPE,
});
const db = await getDb();

console.log('Mensajes en el inbox…\n');

const lista = await gmail.listarMensajes({ labelIds: ['INBOX'], maxResults: TOPE + 1 });
const ids = (lista.messages ?? []).map((m) => m.id);

if (ids.length > TOPE) {
  throw new Error(
    `Hay más de ${TOPE} mensajes en el inbox. Es más de lo esperado para esta casilla, ` +
      'así que el script se detiene en vez de reprocesar a ciegas. Revisá qué pasó antes de forzarlo.',
  );
}

// Las fechas hacen falta para saber hasta dónde retroceder el cursor. Son pocos
// mensajes —el tope son 60— así que traerlos enteros no es caro.
const fechas: Date[] = [];
for (const id of ids) fechas.push(parsearMensaje(await gmail.obtenerMensaje(id)).date);
const masViejo = fechas.sort((a, b) => a.getTime() - b.getTime())[0];

// Solo interesa lo que ya tiene registro: lo demás lo va a tomar el worker solo.
const registrados = await db.emailTriage.findMany({
  where: { gmailMessageId: { in: ids } },
  select: {
    gmailMessageId: true,
    fromEmail: true,
    subject: true,
    category: true,
    gmailWriteEnabled: true,
    externalWriteEnabled: true,
    needsHumanReview: true,
    reviewReason: true,
  },
});

const nuevos = ids.length - registrados.length;

console.log(`${ids.length} en el inbox · ${registrados.length} ya registrados · ${nuevos} que el worker todavía no vio\n`);

const estado = await leerEstadoDeSync();
const fueraDeVentana =
  masViejo !== undefined &&
  estado.lastMessageDate !== null &&
  masViejo < estado.lastMessageDate;

if (fueraDeVentana && masViejo !== undefined) {
  console.log(
    `Cursor en ${estado.lastMessageDate?.toISOString()}, mensaje más viejo del inbox ` +
      `de ${masViejo.toISOString()}.`,
  );
  console.log('Hay mensajes fuera de la ventana: el worker no los lista aunque no tengan registro.');
  console.log('Se va a retroceder el cursor hasta esa fecha.');
  console.log();
}

if (registrados.length === 0 && !fueraDeVentana) {
  console.log('No hay nada que reprocesar: el worker va a tomar los nuevos en la próxima corrida.');
  process.exit(0);
}

for (const r of registrados) {
  const modo = r.externalWriteEnabled
    ? 'escritura completa'
    : r.gmailWriteEnabled
      ? 'solo Gmail'
      : 'shadow';

  // Una revisión bloqueante es la razón por la que un mail se queda en el inbox
  // *a propósito*. Reprocesarlo lo va a dejar exactamente igual.
  const seQuedaIgual = r.needsHumanReview && modo !== 'shadow';

  console.log(`  ${(r.fromEmail ?? '').padEnd(38)} ${r.category.padEnd(17)} [${modo}]`);
  console.log(`     ${(r.subject ?? '(sin asunto)').slice(0, 72)}`);
  if (r.reviewReason !== null && r.reviewReason !== '') {
    console.log(`     revisión: ${r.reviewReason.slice(0, 80)}`);
  }
  if (seQuedaIgual) {
    console.log('     → ya se procesó con escritura y quedó a revisión: reprocesarlo no cambia nada');
  }
  console.log();
}

if (!confirmar) {
  console.log(`Nada borrado. Para hacerlo de verdad:\n`);
  console.log(`  npm run reprocesar:inbox -- --confirmar\n`);
  console.log('Después de eso, la próxima corrida del worker los toma de cero.');
  process.exit(0);
}

const { count } = await db.emailTriage.deleteMany({
  where: { gmailMessageId: { in: registrados.map((r) => r.gmailMessageId) } },
});

console.log(`${count} registros borrados.\n`);

if (fueraDeVentana && masViejo !== undefined) {
  // Un segundo antes del más viejo: `after:` es por día, así que alcanza de sobra.
  // El historyId se limpia para forzar el camino por fecha.
  const nuevoCursor = new Date(masViejo.getTime() - 1000);
  await guardarEstadoDeSync({ historyId: null, lastMessageDate: nuevoCursor });
  console.log(`Cursor retrocedido a ${nuevoCursor.toISOString()}.`);
}
console.log('Los mails no se tocaron: siguen en el inbox, con sus etiquetas.');
console.log('La próxima corrida del worker los va a clasificar y actuar de nuevo.');
console.log('\nSi el worker corre bajo PM2, podés esperar al ciclo o forzarlo con:');
console.log('  pm2 restart commercial-inbox-worker --update-env');
