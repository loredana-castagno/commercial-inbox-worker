import { instalarManejadorDeErrores } from '../cli-errores.js';
import { loadSnovEnv } from '../config.js';
import { SnovClient } from '../snov/client.js';
import { NOMBRE_DE_LISTA, type ListasDeCategoria } from '../snov/enriquecer.js';

/**
 * Contrasta los ids de lista del `.env` contra las listas reales de la cuenta.
 *
 *   npm run snov:listas
 *
 * **Solo lectura.** El cliente se construye sin `escrituraHabilitada`.
 *
 * ## Por qué existe
 *
 * `SNOV_LIST_NO_THANKS` y sus dos hermanas son ids sueltos en el `.env`, y el
 * nombre de la lista que aparece en el log sale del código (`NOMBRE_DE_LISTA`).
 * **Nada ata una cosa con la otra.** Si un id apuntara a la lista equivocada:
 *
 * - Snov responde **200**, porque el alta es válida;
 * - el Sheet dice "subir a Snov: Leads - No thanks", que es mentira;
 * - y como cada lista tiene una **campaña enganchada**, a esa persona le empieza
 *   a llegar una secuencia que no le corresponde.
 *
 * Es la misma clase de falla que casi pasa con do-not-email, y acá es peor porque
 * manda correos a un tercero. Este script la hace visible antes de que ocurra.
 */

instalarManejadorDeErrores();

const env = loadSnovEnv();
const client = new SnovClient({
  clientId: env.SNOV_CLIENT_ID,
  clientSecret: env.SNOV_CLIENT_SECRET,
  apiBase: env.SNOV_API_BASE,
});

const CONFIGURADAS: ListasDeCategoria = {
  NO_THANKS: env.SNOV_LIST_NO_THANKS,
  NOT_NOW: env.SNOV_LIST_NOT_NOW,
  REFERRAL: env.SNOV_LIST_REFERRALS,
};

console.log('Consultando get-user-lists…\n');

const listas = await client.listarListas();

console.log(`${listas.length} lista(s) de prospects en la cuenta:\n`);
for (const l of listas) {
  console.log(
    `  ${String(l.id).padEnd(12)} ${(l.name ?? '(sin nombre)').padEnd(42)}` +
      `${l.contacts ?? '?'} contactos${l.isDeleted === true ? '  [BORRADA]' : ''}`,
  );
}

/**
 * Compara nombres de lista ignorando lo que es cosmético y no cambia a cuál lista
 * apunta el id: comillas tipográficas contra rectas, espacios de más, mayúsculas.
 *
 * Existe porque Snov guarda `Ally’s` con apóstrofo tipográfico (U+2019) y el
 * código lo tiene recto (U+0027). La terminal dibuja los dos igual, así que la
 * primera versión de este script reportaba "NO COINCIDE" mostrando dos strings
 * visualmente idénticos — una alarma que no se puede ni entender ni accionar es
 * peor que no alarmar.
 */
function normalizar(nombre: string): string {
  return nombre
    .normalize('NFKC')
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Los codepoints de lo que difiere, para cuando el desajuste no se ve. */
function dondeDifiere(a: string, b: string): string {
  const largo = Math.max(a.length, b.length);
  for (let i = 0; i < largo; i += 1) {
    if (a[i] !== b[i]) {
      const punto = (c: string | undefined): string =>
        c === undefined ? '(nada)' : `"${c}" U+${c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}`;
      return `posición ${i}: el código tiene ${punto(a[i])}, la cuenta ${punto(b[i])}`;
    }
  }
  return 'difieren en el largo';
}

console.log('\n' + '─'.repeat(78));
console.log('Lo que el worker tiene configurado:');
console.log('─'.repeat(78) + '\n');

let hayProblema = false;

for (const categoria of ['NO_THANKS', 'NOT_NOW', 'REFERRAL'] as const) {
  const id = CONFIGURADAS[categoria];
  const esperado = NOMBRE_DE_LISTA[categoria];
  const real = listas.find((l) => String(l.id) === id);

  console.log(`${categoria}`);
  console.log(`  id configurado : ${id}`);
  console.log(`  el código dice : ${esperado}`);

  if (real === undefined) {
    hayProblema = true;
    console.log('  la cuenta dice : ⚠ ESE ID NO EXISTE en la cuenta');
    console.log('  → el alta va a fallar, o peor, a caer en otro lado.');
  } else if (normalizar(real.name ?? '') !== normalizar(esperado)) {
    hayProblema = true;
    console.log(`  la cuenta dice : ⚠ "${real.name}"`);
    console.log(`  → NO COINCIDE (${dondeDifiere(esperado, real.name ?? '')})`);
    console.log('    El log diría un nombre y el prospect entraría a otra lista,');
    console.log('    con la campaña de esa otra lista escribiéndole.');
  } else if ((real.name ?? '') !== esperado) {
    // Coinciden salvo comillas/espacios/mayúsculas: apunta a la lista correcta,
    // así que no es un problema, pero conviene verlo.
    console.log(`  la cuenta dice : ${real.name}  ✓ (difiere solo en formato)`);
  } else {
    console.log(`  la cuenta dice : ${real.name}  ✓`);
  }

  if (real?.isDeleted === true) {
    hayProblema = true;
    console.log('  → ⚠ la lista está BORRADA en Snov.');
  }
  console.log('');
}

if (hayProblema) {
  console.log('Hay al menos un desajuste. Corregir el `.env` (o `NOMBRE_DE_LISTA`');
  console.log('en src/snov/enriquecer.ts si el que cambió fue el nombre en Snov)');
  console.log('ANTES de que el worker procese otro NO_THANKS / NOT_NOW / REFERRAL.');
  process.exit(1);
}

console.log('Los tres ids apuntan a la lista que el código dice. Nada que corregir.');
