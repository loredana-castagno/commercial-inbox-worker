import { instalarManejadorDeErrores } from '../cli-errores.js';
import { Clasificador } from '../classify/clasificar.js';
import { loadEvalsEnv } from '../config.js';
import { cargarDataset } from '../evals/dataset.js';
import { armarReporte, severidad, type Resultado } from '../evals/metricas.js';

/**
 * Corre el clasificador sobre el dataset anotado y reporta precisión.
 *
 *   npm run evals                       # la muestra (63 anotados por Ally)
 *   npm run evals -- 10                 # los primeros 10, para iterar barato
 *   npm run evals -- --holdout-explicito
 *
 * El holdout está protegido a propósito: medirlo durante la iteración del prompt
 * lo invalida para siempre y después no hay forma de saber que pasó.
 */

instalarManejadorDeErrores();

const args = process.argv.slice(2);
const esHoldout = args.includes('--holdout-explicito');
const limite = Number(args.find((a) => /^\d+$/.test(a)) ?? '0');

const env = loadEvalsEnv();
const dataset = cargarDataset({ holdout: esHoldout, permitirHoldout: esHoldout });

const evaluables = dataset.registros.filter(
  (r) => r.excluidoPorRegla === null && r.categoriaAnotada !== null && r.categoriaAnotada !== 'NO_SE',
);
const aCorrer = limite > 0 ? evaluables.slice(0, limite) : evaluables;

if (aCorrer.length === 0) {
  console.error('No hay mails anotados para evaluar. Anotá primero con: npm run anotar');
  process.exit(1);
}

console.log(`\nEvaluando ${aCorrer.length} mails con ${env.ANTHROPIC_MODEL}${esHoldout ? '  [HOLDOUT]' : ''}\n`);

const clasificador = new Clasificador({
  apiKey: env.ANTHROPIC_API_KEY,
  modelo: env.ANTHROPIC_MODEL,
});

const resultados: Resultado[] = [];
let fallos = 0;

for (const [i, r] of aCorrer.entries()) {
  try {
    const salida = await clasificador.clasificar({
      from: r.from,
      subject: r.subject,
      cuerpo: r.cuerpoLimpio,
    });

    const esperada = r.categoriaAnotada as string;
    resultados.push({
      messageId: r.messageId,
      from: r.from,
      esperada,
      obtenida: salida.categoria,
      confianza: salida.confianza,
      razon: salida.razon,
      severidad: severidad(esperada, salida.categoria),
    });
  } catch (e) {
    // Un fallo del clasificador no aborta la corrida: se cuenta y se sigue, o un
    // solo mail raro tira abajo la medición entera.
    fallos += 1;
    console.error(`  ✖ ${r.from}: ${(e as Error).message.slice(0, 110)}`);
  }

  process.stdout.write(`\r  ${i + 1}/${aCorrer.length}`);
}

console.log('\n');

const reporte = armarReporte(resultados, env.CONFIDENCE_THRESHOLD);

console.log('── Precisión ──');
console.log(`  aciertos exactos          ${reporte.aciertos}/${reporte.total}`);
console.log(`  confusión NO_THANKS↔NOT_NOW ${reporte.hermanas}   (el SPEC no la cuenta como fallo)`);
console.log(`  ────────────────────────────────`);
console.log(`  PRECISIÓN                 ${(reporte.precision * 100).toFixed(1)}%`);
console.log('');
console.log(`  errores leves (ambas van a revisión)  ${reporte.leves}`);
console.log(`  errores GRAVES                        ${reporte.graves}`);
if (fallos > 0) console.log(`  fallos del clasificador               ${fallos}`);

console.log('\n── Por categoría anotada ──');
for (const [categoria, f] of [...reporte.porCategoria.entries()].sort((a, b) => b[1].total - a[1].total)) {
  const pct = ((f.aciertos / f.total) * 100).toFixed(0);
  console.log(`  ${categoria.padEnd(20)} ${String(f.aciertos).padStart(3)}/${String(f.total).padEnd(3)} ${pct.padStart(4)}%`);
}

console.log(
  `\n── Confianza ──\n  ${reporte.bajoUmbral} de ${reporte.total} por debajo de ${env.CONFIDENCE_THRESHOLD} → irían a revisión humana`,
);

const graves = resultados.filter((r) => r.severidad === 'grave');
if (graves.length > 0) {
  console.log('\n── Errores graves, uno por uno ──');
  for (const g of graves) {
    console.log(`\n  ${g.from}`);
    console.log(`    esperada: ${g.esperada}   obtenida: ${g.obtenida}   confianza: ${g.confianza}`);
    console.log(`    razón del modelo: ${g.razon.slice(0, 160)}`);
  }
}

console.log('');
