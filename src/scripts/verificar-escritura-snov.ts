import 'dotenv/config';
import { instalarManejadorDeErrores } from '../cli-errores.js';
import { loadSnovEnv } from '../config.js';
import { SnovClient } from '../snov/client.js';
import { SnovWriter } from '../snov/escritor.js';

/**
 * Verifica `add-prospect-to-list` contra la API real de Snov.
 *
 * Las dos rutas de escritura estaban documentadas pero **sin probar** (SPEC.md
 * § Endpoints). Este script las prueba contra una **lista de prueba sin campaña
 * adosada**: la lista es lo que dispara los envíos, así que sin campaña no sale
 * ningún correo.
 *
 *   npm run snov:verificar-escritura -- <listaId> [email]
 *
 * No toca do-not-email: esa es la operación irreversible y se verifica aparte,
 * con decisión explícita.
 */

instalarManejadorDeErrores();

const env = loadSnovEnv();
const listaId = process.argv[2];
const email = process.argv[3] ?? 'prueba.bot.ally@example.com';

if (listaId === undefined) {
  throw new Error(
    'Falta el id de la lista de prueba. Tiene que ser una lista SIN campaña adosada: ' +
      'una lista con campaña manda correos a quien se agregue.',
  );
}

const cliente = new SnovClient({
  clientId: env.SNOV_CLIENT_ID,
  clientSecret: env.SNOV_CLIENT_SECRET,
  apiBase: env.SNOV_API_BASE,
  escrituraHabilitada: true,
});

console.log('1. La barrera de tipos');
console.log(
  '   sin el flag, SnovWriter.crear() →',
  SnovWriter.crear(cliente, { externalWriteEnabled: false }),
);

const writer = SnovWriter.crear(cliente, { externalWriteEnabled: true });
if (writer === undefined) throw new Error('el writer no se creó con el flag prendido');

console.log(`\n2. Escritura: ${email} → lista ${listaId}`);
const primera = await writer.agregarALista(email, listaId, { fullName: 'Prueba Bot' });
console.log('   primera vez:', JSON.stringify(primera));

// La segunda es la que importa: Snov devuelve 422 y el writer tiene que leerlo
// como éxito idempotente, no como falla (SPEC.md § Endpoints).
const segunda = await writer.agregarALista(email, listaId, { fullName: 'Prueba Bot' });
console.log('   repetida:  ', JSON.stringify(segunda));
if (segunda.estado !== 'ya-estaba') {
  throw new Error(`el duplicado tendría que dar "ya-estaba" y dio "${segunda.estado}"`);
}

// El `success: true` es lo que dice la API, no lo que pasó. Se comprueba leyendo.
console.log('\n3. Relectura (no se confía en el success)');
const prospect = await cliente.buscarProspect(email);
const listas = prospect.data?.[0]?.lists ?? [];
console.log('   listas del prospect:', JSON.stringify(listas));
console.log(
  listas.some((l) => String(l.id) === String(listaId))
    ? '   OK: quedó en la lista'
    : '   NO quedó en la lista',
);
