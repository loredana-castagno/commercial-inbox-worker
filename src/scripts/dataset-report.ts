import { cargarDataset, SIN_CATEGORIA, type RegistroDelDataset } from '../evals/dataset.js';

/**
 * Reporte del dataset anotado.
 *
 * La matriz de cruce es el entregable: cuantifica qué tan mal están los filtros de
 * Gmail hoy. Cada fila es un label puesto por un filtro, cada columna la categoría
 * que puso una persona. La diagonal es acuerdo; todo lo demás es trabajo manual que
 * alguien está haciendo hoy.
 *
 *   npm run dataset:report
 *   npm run dataset:report -- --holdout-explicito
 */

const args = process.argv.slice(2);
const esHoldout = args.includes('--holdout-explicito');
const dataset = cargarDataset({ holdout: esHoldout, permitirHoldout: esHoldout });

const excluidos = dataset.registros.filter((r) => r.excluidoPorRegla !== null);
const evaluables = dataset.registros.filter((r) => r.excluidoPorRegla === null);
const anotados = evaluables.filter((r) => r.categoriaAnotada !== null);

console.log(`\nDataset: ${dataset.registros.length} mails (seed ${dataset.seed}, ${dataset.particion})`);
console.log(
  `Excluidos por regla: ${excluidos.length} (salientes de MyCompany: no son respuestas de prospect)`,
);
console.log(
  `Evaluables: ${evaluables.length} — anotados ${anotados.length}, pendientes ${evaluables.length - anotados.length}`,
);

if (anotados.length === 0) {
  console.log('\nNada anotado todavía. Empezá con: npm run anotar');
  process.exit(0);
}

// ── Distribución por categoría anotada ──────────────────────────────────────
const porCategoria = new Map<string, number>();
for (const r of anotados) {
  const c = r.categoriaAnotada ?? '?';
  porCategoria.set(c, (porCategoria.get(c) ?? 0) + 1);
}

console.log('\n── Distribución por categoría anotada ──');
for (const [categoria, n] of [...porCategoria.entries()].sort((a, b) => b[1] - a[1])) {
  const pct = ((n / anotados.length) * 100).toFixed(1);
  console.log(`  ${categoria.padEnd(20)} ${String(n).padStart(4)}  ${pct.padStart(5)}%  ${'█'.repeat(Math.round(n / 2))}`);
}

const noSe = porCategoria.get(SIN_CATEGORIA) ?? 0;
console.log(
  `\n  "${SIN_CATEGORIA}": ${noSe} (${((noSe / anotados.length) * 100).toFixed(1)}%)` +
    ' — cada uno es un caso que el SPEC no cubre.',
);

// ── Matriz label de Gmail × categoría anotada ───────────────────────────────
const categorias = [...porCategoria.keys()].sort();
const porEtiqueta = new Map<string, Map<string, number>>();

for (const r of anotados) {
  const fila = porEtiqueta.get(r.etiquetaDeMuestreo) ?? new Map<string, number>();
  const c = r.categoriaAnotada ?? '?';
  fila.set(c, (fila.get(c) ?? 0) + 1);
  porEtiqueta.set(r.etiquetaDeMuestreo, fila);
}

console.log('\n── Matriz: label de Gmail (filas) × categoría anotada (columnas) ──');
const anchoFila = 18;
console.log(
  ' '.repeat(anchoFila) + categorias.map((c) => c.slice(0, 8).padStart(9)).join(''),
);

for (const [etiqueta, fila] of porEtiqueta) {
  const celdas = categorias.map((c) => String(fila.get(c) ?? 0).padStart(9)).join('');
  console.log(etiqueta.slice(0, anchoFila - 1).padEnd(anchoFila) + celdas);
}

// ── Acuerdo entre el filtro y la persona ────────────────────────────────────
/** A qué categoría del SPEC apunta cada label, cuando apunta a alguna. */
const EQUIVALENCIA: Record<string, string> = {
  'NO THANKS DRIP': 'NO_THANKS',
  'NOT NOW DRIP': 'NOT_NOW',
  'NOT NOW TWO DRIP': 'NOT_NOW',
  UNSUBSCRIBE: 'UNSUBSCRIBE',
  REFERRAL: 'REFERRAL',
  HOT: 'HOT',
  OOO: 'OOO',
  UNDELIVERABLE: 'UNDELIVERABLE',
  'EMAIL MODIFIED': 'EMAIL_MODIFIED',
};

console.log('\n── Acuerdo filtro vs persona ──');
for (const [etiqueta, fila] of porEtiqueta) {
  const esperada = EQUIVALENCIA[etiqueta];
  if (esperada === undefined) {
    console.log(`  ${etiqueta.padEnd(18)} (sin equivalencia directa en el SPEC)`);
    continue;
  }
  const total = [...fila.values()].reduce((a, b) => a + b, 0);
  const aciertos = fila.get(esperada) ?? 0;
  const pct = ((aciertos / total) * 100).toFixed(0);
  console.log(`  ${etiqueta.padEnd(18)} ${String(aciertos).padStart(3)}/${String(total).padEnd(3)}  ${pct.padStart(3)}%`);
}

// ── Los comentarios, que es donde está lo que no sabíamos ───────────────────
const conComentario = anotados.filter((r: RegistroDelDataset) => r.comentario !== null);
if (conComentario.length > 0) {
  console.log(`\n── Comentarios (${conComentario.length}) ──`);
  for (const r of conComentario) {
    console.log(`  [${r.categoriaAnotada}] ${r.from}: ${r.comentario}`);
  }
}
