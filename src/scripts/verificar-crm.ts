import 'dotenv/config';
import { instalarManejadorDeErrores } from '../cli-errores.js';
import { CrmClient } from '../crm/client.js';
import { aDecimal } from '../crm/escritor.js';

/**
 * Verifica el acceso al CRM contra la instancia que esté en `CRM_BASE_URL`.
 *
 * **Solo lectura.** Hace el `GET`, que es la prueba de que las dos capas de auth
 * quedaron abiertas: si devuelve 401 con la key puesta, falta el cambio del
 * handler. No hace el `POST` — eso crea un contacto y una `Note`, y se prueba
 * aparte con decisión explícita.
 *
 *   npm run crm:verificar -- [email]
 */

instalarManejadorDeErrores();

const baseUrl = process.env.CRM_BASE_URL;
const token = process.env.CRM_SERVICE_TOKEN;

if (baseUrl === undefined || baseUrl === '') throw new Error('Falta CRM_BASE_URL en .env');

console.log(`CRM: ${baseUrl}`);
console.log(`Key: ${token === undefined || token === '' ? 'NO PUESTA' : `puesta (${token.length} caracteres)`}\n`);

const cliente = new CrmClient({ baseUrl, token });

// Una dirección que seguro no existe: el GET devuelve 200 igual, y eso es
// justamente lo que se está verificando.
const email = process.argv[2] ?? 'no-existe-nadie-asi@ejemplo-inexistente.com';

console.log(`1. GET /api/leads/from-email?email=${email}`);
const consulta = await cliente.buscarPorEmail(email);
console.log('   exists:', consulta.exists);
console.log('   suggestedTarget:', consulta.suggestedTarget ?? '(no vino)');
console.log('   OK: 200 con auth válida — las dos capas están abiertas\n');

console.log('2. La escritura NO se prueba acá');
console.log('   El POST crea un Contact y una Note, y cada Note es una llamada al LLM');
console.log('   del lado del CRM. Se prueba aparte, a propósito.\n');

console.log('3. Conversión del id de mensaje');
console.log(`   18f6c827742c0dc9 → ${aDecimal('18f6c827742c0dc9')}`);
console.log('   Sin esto el CRM arma un marcador msg-<timestamp> distinto en cada');
console.log('   corrida, y duplica la Note en cada reproceso.');
