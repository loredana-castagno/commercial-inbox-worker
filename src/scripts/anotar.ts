import readline from 'node:readline';
import { CATEGORIES } from '../categories.js';
import { guardarAnotaciones } from '../evals/anotaciones.js';
import {
  ARCHIVO_HOLDOUT,
  ARCHIVO_MUESTRA,
  cargarDataset,
  guardarDataset,
  SIN_CATEGORIA,
  type RegistroDelDataset,
} from '../evals/dataset.js';

/**
 * Herramienta de anotación. La usa Ally, no nosotros.
 *
 * Dos decisiones que definen si el dataset sirve:
 *
 *  - **No muestra el label de Gmail ni ninguna sugerencia.** El sesgo de anclaje es
 *    fuerte, y los casos ambiguos son justo los que importan. Si ve "UNSUBSCRIBE"
 *    arriba, la anotación mide qué tan de acuerdo está con el filtro, no qué
 *    categoría es.
 *  - **"No sé" es una respuesta de primera clase.** Junto con el comentario, es
 *    donde aparecen los casos que el SPEC no cubre. Un dataset sin "no sé" no es
 *    uno limpio: es uno donde se forzaron las dudas.
 *
 * Guarda después de cada mail: se puede cortar en cualquier momento y retomar.
 *
 * Sobre la implementación: usa el iterador de líneas de `readline` y no
 * `readline/promises`. Con stdin redirigido, `promises` entrega la primera línea y
 * descarta el resto — o sea que un input automatizado perdería respuestas sin
 * avisar. El iterador anda igual interactivo y redirigido, y por eso esto se puede
 * probar de punta a punta.
 *
 *   npm run anotar
 *   npm run anotar -- --holdout-explicito
 */

const args = process.argv.slice(2);
const esHoldout = args.includes('--holdout-explicito');

const dataset = cargarDataset({ holdout: esHoldout, permitirHoldout: esHoldout });
const archivo = esHoldout ? ARCHIVO_HOLDOUT : ARCHIVO_MUESTRA;

type Opcion = NonNullable<RegistroDelDataset['categoriaAnotada']>;
const OPCIONES: readonly Opcion[] = [...CATEGORIES, SIN_CATEGORIA];

const pendientes = dataset.registros.filter((r) => r.categoriaAnotada === null);
const yaHechos = dataset.registros.length - pendientes.length;

function escribir(texto: string): void {
  process.stdout.write(texto);
}

function mostrarMenu(): void {
  escribir('\nCategorías:\n');
  const porColumna = Math.ceil(OPCIONES.length / 2);
  for (let i = 0; i < porColumna; i += 1) {
    let linea = '';
    for (const c of [0, 1]) {
      const idx = i + c * porColumna;
      const opcion = OPCIONES[idx];
      if (opcion !== undefined) linea += `  ${String(idx + 1).padStart(2)}) ${opcion.padEnd(20)}`;
    }
    escribir(linea + '\n');
  }
  escribir('   c) ver cuerpo crudo    s) saltear    q) guardar y salir\n> ');
}

function mostrarMail(r: RegistroDelDataset, indice: number): void {
  escribir('\n' + '═'.repeat(78) + '\n');
  escribir(`Mail ${indice + 1} de ${dataset.registros.length}${esHoldout ? '  [HOLDOUT]' : ''}\n`);
  escribir('═'.repeat(78) + '\n');
  escribir(`De:      ${r.fromNombre ?? '(sin nombre)'} <${r.from}>\n`);
  escribir(`Asunto:  ${r.subject ?? '(sin asunto)'}\n`);
  escribir(`Fecha:   ${r.date.slice(0, 10)}\n`);
  // labelsGmail está en el registro pero NO se imprime: ver el comentario de arriba.
  escribir('─'.repeat(78) + '\n');
  escribir((r.cuerpoLimpio === '' ? '(cuerpo vacío)' : r.cuerpoLimpio) + '\n');
  escribir('─'.repeat(78) + '\n');
}

escribir(`\nAnotación — ${archivo}\n`);
escribir(
  `${dataset.registros.length} mails, ${yaHechos} ya anotados, ${pendientes.length} pendientes.\n`,
);
escribir('Se guarda después de cada uno: podés cortar con q y retomar cuando quieras.\n');

if (pendientes.length === 0) {
  escribir('\nNo queda nada por anotar. Reporte: npm run dataset:report\n');
  process.exit(0);
}

escribir('\n¿Quién anota? (nombre): ');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

type Estado = 'nombre' | 'categoria' | 'comentario';
let estado: Estado = 'nombre';
let quien = 'anónimo';
let indice = 0;
let categoriaElegida: Opcion | undefined;
let anotados = 0;

function siguienteMail(): void {
  if (indice >= pendientes.length) {
    escribir(`\nListo: ${anotados} anotados en esta sesión.\n`);
    escribir('Reporte: npm run dataset:report\n');
    rl.close();
    process.exit(0);
  }
  mostrarMail(pendientes[indice] as RegistroDelDataset, yaHechos + indice);
  mostrarMenu();
}

for await (const linea of rl) {
  const entrada = linea.trim();

  if (estado === 'nombre') {
    quien = entrada === '' ? 'anónimo' : entrada;
    estado = 'categoria';
    siguienteMail();
    continue;
  }

  const registro = pendientes[indice] as RegistroDelDataset;

  if (estado === 'comentario') {
    registro.categoriaAnotada = categoriaElegida ?? null;
    registro.comentario = entrada === '' ? null : entrada;
    registro.anotadoPor = quien;
    registro.anotadoEn = new Date().toISOString();
    guardarDataset(dataset);
    // Y al archivo versionado: es lo único de todo esto que no se puede rehacer.
    guardarAnotaciones(dataset);

    escribir(`✓ ${registro.categoriaAnotada}\n`);
    anotados += 1;
    indice += 1;
    estado = 'categoria';
    siguienteMail();
    continue;
  }

  // estado === 'categoria'
  const opcion = entrada.toLowerCase();

  if (opcion === 'q') {
    escribir(`\nGuardado. Quedan ${pendientes.length - indice} sin anotar.\n`);
    rl.close();
    process.exit(0);
  }

  if (opcion === 's') {
    indice += 1;
    siguienteMail();
    continue;
  }

  if (opcion === 'c') {
    escribir('\n--- CUERPO CRUDO ---\n');
    escribir(registro.cuerpoCrudo + '\n');
    escribir('--- fin ---\n');
    mostrarMenu();
    continue;
  }

  const n = Number(opcion);
  const categoria = Number.isInteger(n) ? OPCIONES[n - 1] : undefined;

  if (categoria === undefined) {
    escribir('No entendí. Poné el número de una categoría, o c / s / q.\n');
    mostrarMenu();
    continue;
  }

  categoriaElegida = categoria;
  estado = 'comentario';
  escribir(`${categoria} — comentario (opcional, Enter para saltear): `);
}
