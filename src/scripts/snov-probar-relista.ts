import 'dotenv/config';
import { instalarManejadorDeErrores } from '../cli-errores.js';
import { loadSnovEnv } from '../config.js';
import { SnovClient } from '../snov/client.js';
import { respuestaDeEscrituraSchema } from '../snov/escritor.js';
import { enriquecerProspect } from '../snov/enriquecer.js';
import { primerNombre } from '../execute/plantillas.js';

/**
 * Responde una pregunta concreta contra la API real: **¿cómo se suma a una lista
 * un prospect que ya existe en otra?**
 *
 *   npm run snov:probar-relista -- <listaDePruebaId> <email-que-ya-existe> --confirmar
 *
 * ## Por qué existe
 *
 * Medido en producción (agosto 2026) sobre un `NOT_NOW` real:
 * `add-prospect-to-list` con un prospect que **ya existe** devuelve 200, actualiza
 * sus datos (se vio el `fullName` cambiar en la UI de Snov) y **lo deja en su
 * lista original**. Nunca entra a la lista que le pasamos.
 *
 * Como todo el que responde una campaña ya existe en Snov, eso significa que
 * ningún `NO_THANKS` / `NOT_NOW` / `REFERRAL` estaba llegando a su lista de drip
 * — con el worker reportando éxito.
 *
 * La doc menciona dos parámetros que nunca mandamos, `updateContact` y
 * `createDuplicates`, y dice que solo uno puede estar en `true`. Este script
 * prueba las variantes y muestra en qué listas queda el prospect después de cada
 * una, en vez de deducirlo de una doc que ya se equivocó varias veces.
 *
 * ## Seguridad
 *
 * **La lista de prueba tiene que ser una lista SIN campaña adosada.** La lista es
 * lo que dispara los envíos: sin campaña, agregar a alguien no manda nada.
 */

instalarManejadorDeErrores();

const listaId = process.argv[2];
const email = process.argv[3];
const confirmar = process.argv.includes('--confirmar');
/** Con el formato de Outlook, que es el que más cuesta: el nombre va tras la coma. */
const nombreCompleto = 'Prueba, Bot';

if (listaId === undefined || email === undefined || !email.includes('@')) {
  throw new Error(
    'Uso: npm run snov:probar-relista -- <listaDePruebaId> <email> --confirmar\n' +
      'OJO: si la lista tiene campaña, el alta enrola a esa dirección y le manda correos.',
  );
}

const env = loadSnovEnv();
const cliente = new SnovClient({
  clientId: env.SNOV_CLIENT_ID,
  clientSecret: env.SNOV_CLIENT_SECRET,
  apiBase: env.SNOV_API_BASE,
  escrituraHabilitada: confirmar,
});

async function listasDe(quien: string): Promise<string> {
  const e = await enriquecerProspect(cliente, quien);
  if (!e.esProspect) return '(no es prospect)';
  return e.listas.map((l) => `${l.name} (${l.id})`).join(', ') || '(sin listas)';
}

console.log(`Prospect: ${email}`);
console.log(`Lista de prueba: ${listaId}\n`);
console.log(`Listas ANTES: ${await listasDe(email)}\n`);

if (!confirmar) {
  console.log('Sin --confirmar no se escribe nada. Para probar de verdad:');
  console.log(`  npm run snov:probar-relista -- ${listaId} ${email} --confirmar`);
  console.log('\nOJO: si esa lista tiene campaña, el alta enrola a esa dirección.');
  process.exit(0);
}

const variantes: { nombre: string; extra: Record<string, string> }[] = [
  { nombre: 'sin flags (lo que hace el worker hoy)', extra: {} },
  { nombre: 'updateContact=true', extra: { updateContact: 'true' } },
  { nombre: 'createDuplicates=true', extra: { createDuplicates: 'true' } },
];

for (const v of variantes) {
  console.log('─'.repeat(74));
  console.log(v.nombre);
  try {
    // Los mismos campos de nombre que manda el worker. **Sin esto la prueba
    // miente**: Snov deriva un nombre del mail (`lcastagno` → "Lcastagno") y deja
    // First/Last vacíos, y después el perfil de prueba parece mostrar que el
    // worker no guarda el nombre — cuando el que no lo mandaba era el script.
    const r = await cliente.escribir('add-prospect-to-list', respuestaDeEscrituraSchema, {
      email,
      listId: listaId,
      fullName: nombreCompleto,
      firstName: primerNombre(nombreCompleto) ?? '',
      ...v.extra,
    });
    console.log(`  respuesta: ${JSON.stringify(r)}`);
  } catch (error) {
    const e = error as { status?: number; cuerpo?: string; message?: string };
    console.log(`  ERROR ${e.status ?? ''}: ${e.cuerpo ?? e.message ?? String(error)}`);
  }
  console.log(`  listas después: ${await listasDe(email)}`);
  console.log('');
}

console.log('─'.repeat(74));
console.log('La variante que haga aparecer la lista de prueba en "listas después"');
console.log('es la que el worker tiene que usar.');
