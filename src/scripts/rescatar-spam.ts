import 'dotenv/config';
import { instalarManejadorDeErrores } from '../cli-errores.js';
import { getConfig } from '../config.js';
import { CrmClient } from '../crm/client.js';
import { crearClienteAutenticado } from '../gmail/auth.js';
import { GmailClient } from '../gmail/client.js';
import { ETIQUETA_DE_RESCATE } from '../gmail/etiquetas.js';
import { GmailWriter } from '../gmail/escritor.js';
import { buscarRescatablesEnSpam, origenDe } from '../gmail/spam.js';
import { SnovClient } from '../snov/client.js';

/**
 * Rescata de Spam las respuestas reales de prospects, a mano.
 *
 *   npm run rescatar:spam                # solo muestra, no toca nada
 *   npm run rescatar:spam -- --confirmar
 *
 * **El worker ya hace esto solo cada `SPAM_SWEEP_HOURS`.** Este script existe para
 * mirar antes de tocar —la vista previa no escribe nada— y para forzar un barrido
 * sin esperar al ciclo. La lógica es la misma: `buscarRescatablesEnSpam`.
 *
 * ## El problema
 *
 * Gmail manda a Spam respuestas legítimas a las campañas, y hoy las rescata Ally a
 * mano. Medido sobre la casilla: **13 mensajes, 1 claramente una respuesta a
 * campaña** — volumen bajo pero no cero, y cada una perdida es una respuesta que
 * nunca se procesa.
 *
 * El fetch normal no las ve: `messages.list` excluye Spam y Papelera por default.
 * Por eso Spam necesita su propio barrido.
 *
 * ## Por qué esto sí funciona y las tres reglas anteriores no
 *
 * SPEC.md § Spam documenta tres reglas determinísticas que se probaron y fallaron:
 * que el hilo tenga un mail nuestro, que el `In-Reply-To` apunte a algo que
 * enviamos, y que el cuerpo mencione MyCompany. **Las tres miran adentro de Gmail**, y
 * ahí está el problema de fondo: las campañas salen desde Snov, así que el envío
 * original no existe en la casilla. La tercera además da falsos positivos con el
 * phishing, que menciona MyCompany *porque* se hace pasar por MyCompany.
 *
 * La señal que sí sirve **vive afuera**: ¿este remitente está en Snov o en el CRM?
 * Un phishing no está; un prospect al que le escribimos, sí.
 *
 * ## Qué pasa después
 *
 * El rescate saca de Spam, devuelve al inbox y etiqueta. **Este script no
 * clasifica**: los deja en el inbox y el worker los procesa en su próxima corrida,
 * como a cualquier otro mail.
 *
 * Que el bot actúe sobre ellos es seguro porque la guarda de `NO_ES_RESPUESTA` ya
 * cubre el caso peligroso: si el clasificador quisiera archivar como ruido a alguien
 * que está en Snov, no lo deja. Y es justamente porque está en Snov que se rescató.
 */

instalarManejadorDeErrores();

/** Tope de mensajes a revisar. Cada uno cuesta una consulta a Snov y otra al CRM. */
const TOPE = 100;

const confirmar = process.argv.includes('--confirmar');

const config = getConfig();
const gmail = new GmailClient(crearClienteAutenticado(config), {
  scopeConfigurado: config.GMAIL_SCOPE,
  escrituraHabilitada: config.GMAIL_WRITE_ENABLED,
});
const writer = GmailWriter.crear(gmail, { gmailWriteEnabled: config.GMAIL_WRITE_ENABLED });
const snov = new SnovClient({
  clientId: config.SNOV_CLIENT_ID,
  clientSecret: config.SNOV_CLIENT_SECRET,
  apiBase: config.SNOV_API_BASE,
});
const crm = new CrmClient({ baseUrl: config.CRM_BASE_URL, token: config.CRM_SERVICE_TOKEN });

console.log('Revisando Spam…\n');

const resumen = await buscarRescatablesEnSpam({
  gmail,
  snov,
  ...(config.CRM_SERVICE_TOKEN === undefined ? {} : { crm }),
  dominiosPropios: ['mycompany.co', 'mycompany.com', 'mycompany.net'],
  tope: TOPE,
});

console.log(
  `${resumen.revisados} en Spam · ${resumen.propios} salientes nuestros · ` +
    `${resumen.rescatables.length} de prospects conocidos · ${resumen.desconocidos} desconocidos\n`,
);

if (resumen.rescatables.length === 0) {
  console.log('Nada para rescatar: ningún remitente de Spam está en Snov ni en el CRM.');
  process.exit(0);
}

console.log('SE RESCATAN — el remitente está en nuestro proceso:\n');
for (const r of resumen.rescatables) {
  console.log(`  ${r.mensaje.from.email.padEnd(38)} [${origenDe(r)}]`);
  console.log(`     ${(r.mensaje.subject ?? '(sin asunto)').slice(0, 74)}`);
}

console.log(`\nSe quedan en Spam ${resumen.desconocidos} de remitentes desconocidos.`);
console.log('Entre ellos suele haber phishing que menciona MyCompany: no está en Snov y por eso no se toca.\n');

if (!confirmar) {
  console.log('Nada movido. Para hacerlo de verdad:\n');
  console.log('  npm run rescatar:spam -- --confirmar\n');
  process.exit(0);
}

if (writer === undefined) {
  throw new Error(
    'GMAIL_WRITE_ENABLED=false: sacar un mail de Spam es una escritura en la casilla.',
  );
}

for (const r of resumen.rescatables) {
  await writer.sacarDeSpam(r.mensaje.messageId, ETIQUETA_DE_RESCATE);
  console.log(`  ✓ ${r.mensaje.from.email}`);
}

console.log(`\n${resumen.rescatables.length} mails devueltos al inbox con "${ETIQUETA_DE_RESCATE}".`);
console.log('El worker los va a procesar en su próxima corrida, como cualquier mail del inbox.');
