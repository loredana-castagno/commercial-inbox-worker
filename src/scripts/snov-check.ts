import { instalarManejadorDeErrores } from '../cli-errores.js';
import { loadSnovEnv } from '../config.js';
import { SnovClient } from '../snov/client.js';
import { enriquecerProspect, yaEnListaDe, type ListasDeCategoria } from '../snov/enriquecer.js';

/**
 * Enriquece una o varias direcciones contra Snov y muestra qué salió.
 *
 * El equivalente de `gmail:peek` para el enriquecimiento: sirve para verificar a
 * ojo, sobre prospects reales, antes de que este dato alimente ninguna regla.
 *
 *   npm run snov:check -- juan@acme.com otro@empresa.com
 *
 * Solo lectura: el cliente no expone escritura.
 */

instalarManejadorDeErrores();

const emails = process.argv.slice(2).filter((a) => a.includes('@'));
if (emails.length === 0) {
  console.error('Uso: npm run snov:check -- mail@ejemplo.com [otro@ejemplo.com ...]');
  process.exit(1);
}

const env = loadSnovEnv();
const client = new SnovClient({
  clientId: env.SNOV_CLIENT_ID,
  clientSecret: env.SNOV_CLIENT_SECRET,
  apiBase: env.SNOV_API_BASE,
});

const listas: ListasDeCategoria = {
  NO_THANKS: env.SNOV_LIST_NO_THANKS,
  NOT_NOW: env.SNOV_LIST_NOT_NOW,
  REFERRAL: env.SNOV_LIST_REFERRALS,
};

for (const email of emails) {
  const e = await enriquecerProspect(client, email);

  console.log('\n' + '─'.repeat(74));
  console.log(email);
  console.log('─'.repeat(74));

  if (!e.esProspect) {
    console.log('  NO es prospect nuestro.');
    console.log('  → nunca le escribimos: guarda de NO_ES_RESPUESTA y del rescate de spam.');
    continue;
  }

  console.log(`  prospect: ${e.nombre ?? '(sin nombre)'}`);
  console.log(`  listas  : ${e.listas.map((l) => `${l.name} (${l.id})`).join(', ') || '(ninguna)'}`);
  console.log(`  campañas: ${e.campanas.join(', ') || '(ninguna)'}`);
  console.log(`  cuentan : ${e.campanasQueCuentan.join(', ') || '(ninguna)'} → ${e.campanasQueCuentan.length}`);

  if (e.multiCampana) {
    console.log('  ⚠ multi-campaña: va a REVISIÓN HUMANA con estos nombres. No se sube a do-not-email.');
  }

  console.log('  segunda respuesta si la categoría fuera:');
  for (const categoria of ['NO_THANKS', 'NOT_NOW', 'REFERRAL'] as const) {
    const ya = yaEnListaDe(e.listas, categoria, listas);
    console.log(`    ${categoria.padEnd(10)} ${ya ? 'SÍ → TO_MANUAL_SORT' : 'no → primera vez'}`);
  }
}

console.log('');
