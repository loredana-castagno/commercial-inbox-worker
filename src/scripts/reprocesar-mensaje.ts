import 'dotenv/config';
import { instalarManejadorDeErrores } from '../cli-errores.js';
import { getDb } from '../db.js';
import { guardarEstadoDeSync, leerEstadoDeSync } from '../sync-state.js';

/**
 * Borra el registro de triage de mensajes puntuales, por remitente, para que la
 * corrida siguiente los procese de cero.
 *
 *   npm run reprocesar:mensaje -- --email direccion@ejemplo.com
 *   npm run reprocesar:mensaje -- --email direccion@ejemplo.com --confirmar
 *
 * `--desde <fecha ISO>` fuerza el retroceso del cursor a esa fecha aunque no
 * haya (o ya no haya) fila que borrar — para el caso de haber corrido este
 * script antes de que tuviera el retroceso de cursor: la fila ya no está, pero
 * el cursor tampoco se movió nunca. Sin este flag no hay forma de recuperar
 * ese estado a mitad de camino sin conocer la fecha del mail a mano (Sheet o
 * Gmail).
 *
 *   npm run reprocesar:mensaje -- --email direccion@ejemplo.com --desde 2026-08-24T13:43:00Z --confirmar
 *
 * ## Por qué existe, y en qué se distingue de `reprocesar:inbox`
 *
 * `reprocesar:inbox` solo toca lo que sigue en el inbox — a propósito, para no
 * repetir acciones sobre correo ya resuelto. Pero una acción puede fallar sobre un
 * mail que **ya salió** del inbox: el caso real que motivó este script fue un
 * `UNSUBSCRIBE` cuyo `etiquetar` y `sacar del inbox` salieron bien, y la subida a
 * do-not-email de Snov falló con 404 — el mail quedó archivado, con su etiqueta, y
 * la persona pidiendo salir de las campañas **sin haber salido**. Ese mail no
 * aparece en el inbox, así que `reprocesar:inbox` no lo iba a encontrar nunca.
 *
 * Este script apunta por remitente en vez de por rango, y por eso trae más
 * fricción a propósito: muestra todo lo que hay antes de borrar nada, y solo un
 * `--confirmar` explícito borra.
 *
 * **Nunca toca Gmail ni Snov ni el CRM.** Solo borra filas de `EmailTriage` y,
 * si hace falta, retrocede el cursor. Los mails no se mueven, no se re-etiquetan
 * acá: lo único que cambia es que el worker vuelve a considerarlos.
 *
 * ## Por qué también retrocede el cursor
 *
 * Borrar la fila no alcanza si el mensaje quedó fuera de la ventana que el
 * worker realmente vuelve a mirar — y para un mail que ya salió del inbox, esto
 * es **casi siempre** el caso, a diferencia de `reprocesar:inbox`. `history.list`
 * es incremental: solo devuelve cambios *desde* el `historyId` guardado, así que
 * un mensaje cuyo evento de alta ya quedó atrás del cursor no vuelve a aparecer
 * aunque se borre su fila — se comprobó en vivo (agosto 2026): `reprocesar:mensaje`
 * sin este rewind borró el registro y la corrida siguiente igual dijo "0 mensajes
 * nuevos". Mismo mecanismo que usa `reprocesar:inbox` para su propio caso: fuerza
 * el camino por fecha (`historyId: null`) y retrocede `lastMessageDate` a justo
 * antes del mensaje más viejo que se está reprocesando.
 */

instalarManejadorDeErrores();

const args = process.argv.slice(2);
const confirmar = args.includes('--confirmar');
const idxEmail = args.indexOf('--email');
const email = idxEmail === -1 ? undefined : args[idxEmail + 1];
const idxDesde = args.indexOf('--desde');
const desdeTexto = idxDesde === -1 ? undefined : args[idxDesde + 1];

if (email === undefined || email === '') {
  throw new Error('Uso: npm run reprocesar:mensaje -- --email direccion@ejemplo.com [--desde <ISO>] [--confirmar]');
}

let desde: Date | undefined;
if (desdeTexto !== undefined) {
  desde = new Date(desdeTexto);
  if (Number.isNaN(desde.getTime())) {
    throw new Error(`"${desdeTexto}" no es una fecha ISO válida para --desde.`);
  }
}

const db = await getDb();

const registrados = await db.emailTriage.findMany({
  where: { fromEmail: email },
  orderBy: { receivedAt: 'desc' },
  select: {
    gmailMessageId: true,
    fromName: true,
    subject: true,
    receivedAt: true,
    category: true,
    needsHumanReview: true,
    reviewReason: true,
    gmailWriteEnabled: true,
    externalWriteEnabled: true,
  },
});

if (registrados.length === 0 && desde === undefined) {
  console.log(`No hay ningún mensaje registrado de ${email}. No hay nada que reprocesar.`);
  process.exit(0);
}

if (registrados.length === 0) {
  console.log(
    `No hay ningún mensaje registrado de ${email}, pero se pidió --desde: se va a ` +
      'retroceder el cursor igual, sin borrar nada (probablemente ya se borró antes).',
  );
} else {
  console.log(`${registrados.length} mensaje(s) registrado(s) de ${email}:\n`);
}

for (const r of registrados) {
  const modo = r.externalWriteEnabled
    ? 'escritura completa'
    : r.gmailWriteEnabled
      ? 'solo Gmail'
      : 'shadow';

  console.log(`  ${r.receivedAt.toISOString()}  ${r.category.padEnd(17)} [${modo}]`);
  console.log(`     ${(r.subject ?? '(sin asunto)').slice(0, 72)}`);
  if (r.needsHumanReview) {
    console.log(`     revisión pendiente${r.reviewReason ? `: ${r.reviewReason.slice(0, 100)}` : ' (ver el Sheet para el motivo — el registro no lo guarda si la falla fue en la ejecución, no en la decisión)'}`);
  }
  console.log(`     id: ${r.gmailMessageId}`);
  console.log();
}

if (!confirmar) {
  console.log('Nada borrado, ningún cursor tocado. Para hacerlo de verdad:\n');
  console.log(
    `  npm run reprocesar:mensaje -- --email ${email}` +
      (desde === undefined ? '' : ` --desde ${desdeTexto}`) +
      ' --confirmar\n',
  );
  console.log('Después de eso, la próxima corrida del worker los toma de cero.');
  process.exit(0);
}

const { count } = await db.emailTriage.deleteMany({ where: { fromEmail: email } });

console.log(`${count} registro(s) borrado(s).\n`);
console.log('Los mails no se tocaron: conservan sus etiquetas y su ubicación actual.');

const fechas = registrados.map((r) => r.receivedAt);
if (desde !== undefined) fechas.push(desde);
const masViejo = fechas.reduce((a, b) => (a < b ? a : b));

// Un segundo antes: `after:` de Gmail es por día, así que alcanza de sobra, y
// evita el borde de "justo en el mismo instante" quedando afuera del rango.
const cursorNecesario = new Date(masViejo.getTime() - 1000);

const estado = await leerEstadoDeSync();

// Solo se saltea el retroceso si YA se está en el camino por fecha (sin
// historyId) y la fecha guardada ya cubre esto. `historyId` no nulo siempre
// obliga a forzar el camino por fecha: history.list es incremental y no
// "vuelve atrás" para relistar algo que ya pasó, sin importar qué fecha tenga
// guardada lastMessageDate.
const yaLoTapa =
  estado.historyId === null &&
  estado.lastMessageDate !== null &&
  estado.lastMessageDate <= cursorNecesario;

if (yaLoTapa) {
  console.log('El cursor ya cubre este mensaje: no hace falta retrocederlo.');
} else {
  // Nunca adelanta el cursor: si ya estaba más atrás que lo necesario, se deja.
  const nuevoCursor =
    estado.lastMessageDate === null || estado.lastMessageDate > cursorNecesario
      ? cursorNecesario
      : estado.lastMessageDate;
  await guardarEstadoDeSync({ historyId: null, lastMessageDate: nuevoCursor });
  console.log(`Cursor retrocedido a ${nuevoCursor.toISOString()} para que la próxima corrida lo vuelva a listar.`);
}

console.log('\nLa próxima corrida del worker los va a clasificar y actuar de nuevo.');
console.log('Si el worker corre bajo PM2, podés esperar al ciclo o forzarlo con:');
console.log('  pm2 restart commercial-inbox-worker --update-env');
