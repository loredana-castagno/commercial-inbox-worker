import { instalarManejadorDeErrores } from '../cli-errores.js';
import { loadSnovEnv } from '../config.js';
import { SnovClient } from '../snov/client.js';

/**
 * Lista las listas de do-not-email de la cuenta y verifica cuál está configurada.
 *
 *   npm run snov:do-not-email
 *
 * **Solo lectura.** El cliente se construye sin `escrituraHabilitada`, así que
 * este script no puede escribir aunque quiera.
 *
 * ## Por qué existe
 *
 * Nació para diagnosticar el 404 de la baja en do-not-email, pero lo que lo hace
 * valer es otra cosa: **la cuenta tiene siete listas de do-not-contact**, dos de
 * ellas con decenas de miles de entradas (`Do-not-email (full list)` con 94.322 y
 * una de HR MyCompany con 87.767).
 *
 * Dar de baja en la lista equivocada **devuelve 200 y no protege de nada**: el
 * prospect sigue recibiendo la campaña. Es la falla silenciosa más cara del
 * sistema, sobre la única acción que no se deshace. Este script confirma que el id
 * de `SNOV_DO_NOT_EMAIL_LIST` existe y es el que corresponde.
 */

instalarManejadorDeErrores();

const env = loadSnovEnv();
const client = new SnovClient({
  clientId: env.SNOV_CLIENT_ID,
  clientSecret: env.SNOV_CLIENT_SECRET,
  apiBase: env.SNOV_API_BASE,
});

console.log('Consultando /v2/blacklists…\n');

const respuesta = await client.listarListasDeDoNotEmail();

// Crudo y completo: el schema es laxo a propósito, y lo que interesa acá es ver
// exactamente qué devuelve la API, no una vista resumida que esconda un campo.
console.log(JSON.stringify(respuesta, null, 2));

const listas = respuesta.data ?? [];
const configurada = env.SNOV_DO_NOT_EMAIL_LIST;

if (listas.length === 0) {
  console.log('\nLa respuesta no trajo listas. Revisar el JSON de arriba.');
} else {
  console.log(`\n${listas.length} lista(s) de do-not-email:\n`);
  for (const l of listas) {
    const marca = configurada !== undefined && String(l.id) === configurada
      ? '  <-- SNOV_DO_NOT_EMAIL_LIST'
      : '';
    console.log(`  ${String(l.id).padEnd(12)} ${(l.name ?? '(sin nombre)').padEnd(32)}${marca}`);
  }

  console.log('');
  if (configurada === undefined) {
    console.log('SNOV_DO_NOT_EMAIL_LIST no está en el .env: el worker usa el default del código.');
  } else if (listas.some((l) => String(l.id) === configurada)) {
    console.log(`El id configurado (${configurada}) existe en la cuenta.`);
    console.log('Confirmá arriba que el nombre sea el de la lista que usan las campañas.');
  } else {
    console.log(`ATENCIÓN: el id configurado (${configurada}) NO está entre las listas de la cuenta.`);
    console.log('Las bajas irían a una lista inexistente o equivocada.');
  }
}
