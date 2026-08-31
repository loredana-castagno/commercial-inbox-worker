import 'dotenv/config';
import { instalarManejadorDeErrores } from '../cli-errores.js';
import { loadSnovEnv } from '../config.js';
import { SnovClient } from '../snov/client.js';
import { hashDeVerificacion } from '../snov/schemas.js';

/**
 * Corre el verificador de emails de Snov y muestra qué devuelve.
 *
 *   npm run snov:verificar-email -- alguien@empresa.com --confirmar
 *   npm run snov:verificar-email -- --hash <task_hash>
 *
 * ## Por qué existe
 *
 * **Las campañas de Snov no arrancan si el contacto no está verificado.** Un
 * prospect que el worker sube queda como `Not verified`, así que el drip nunca
 * empieza y todo lo que subimos queda inerte.
 *
 * La pregunta que este script contesta es una sola, y la doc no la responde:
 * **¿llamar al verificador marca al prospect en su lista, o solo devuelve un
 * resultado suelto?** De eso depende si el worker puede resolverlo o si queda
 * como paso manual. La respuesta se ve mirando la UI de Snov antes y después.
 *
 * ## Costo
 *
 * **El verificador es un producto pago: consume créditos de la cuenta.** Por eso
 * pide `--confirmar`, por eso el método vive detrás de `escrituraHabilitada`
 * aunque no escriba en ninguna lista, y por eso existe `--hash`: consultar el
 * resultado de una verificación ya arrancada no gasta de nuevo.
 */

instalarManejadorDeErrores();

const args = process.argv.slice(2);
const confirmar = args.includes('--confirmar');
const idxHash = args.indexOf('--hash');
const hashDado = idxHash === -1 ? undefined : args[idxHash + 1];
const email = args.find((a) => a.includes('@'));

if (hashDado === undefined && email === undefined) {
  throw new Error(
    'Uso: npm run snov:verificar-email -- alguien@empresa.com --confirmar\n' +
      '  o: npm run snov:verificar-email -- --hash <task_hash>   (no gasta créditos)',
  );
}

const env = loadSnovEnv();
const cliente = new SnovClient({
  clientId: env.SNOV_CLIENT_ID,
  clientSecret: env.SNOV_CLIENT_SECRET,
  apiBase: env.SNOV_API_BASE,
  escrituraHabilitada: confirmar,
});

let hash = hashDado;

if (hash === undefined) {
  if (!confirmar) {
    console.log(`Verificaría ${email}.\n`);
    console.log('El verificador de Snov consume créditos, así que no corre sin');
    console.log('confirmación explícita:\n');
    console.log(`  npm run snov:verificar-email -- ${email} --confirmar`);
    process.exit(0);
  }

  console.log(`Arrancando verificación de ${email}…\n`);
  const inicio = await cliente.iniciarVerificacion([email as string]);
  console.log(JSON.stringify(inicio, null, 2));

  hash = hashDeVerificacion(inicio);
  if (hash === undefined) {
    console.log('\nLa respuesta no trajo task_hash. Revisar el JSON de arriba.');
    process.exit(1);
  }
}

console.log(`\ntask_hash: ${hash}\nConsultando el resultado…\n`);

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

for (let intento = 1; intento <= 10; intento += 1) {
  const r = await cliente.resultadoDeVerificacion(hash);
  console.log(`intento ${intento}: ${JSON.stringify(r)}`);

  const datos = r.data;
  const listo =
    r.status === 'completed' ||
    (Array.isArray(datos) && datos.length > 0) ||
    (datos !== null && typeof datos === 'object' && Object.keys(datos).length > 0);

  if (listo) {
    console.log('\nListo. Ahora mirá el prospect en la UI de Snov:');
    console.log('  ¿pasó de "Not verified" a verificado?');
    console.log('  SÍ  → el worker puede verificar lo que sube, y el drip arranca solo.');
    console.log('  NO  → el verificador no marca al prospect: queda como paso manual.');
    process.exit(0);
  }

  await dormir(3000);
}

console.log('\nSe agotaron los intentos sin resultado. Puede tardar más:');
console.log(`  npm run snov:verificar-email -- --hash ${hash}`);
