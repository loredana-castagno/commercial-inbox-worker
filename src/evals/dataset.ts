import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CATEGORIES } from '../categories.js';

const raizDelRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIRECTORIO = path.join(raizDelRepo, 'evals', 'dataset');

export const ARCHIVO_MUESTRA = path.join(DIRECTORIO, 'muestra.json');
export const ARCHIVO_HOLDOUT = path.join(DIRECTORIO, 'holdout.json');

/** `NO_SE` no es una categoría del SPEC: es la señal de que el SPEC no alcanza. */
export const SIN_CATEGORIA = 'NO_SE';

export const anotacionSchema = z.object({
  categoriaAnotada: z.enum([...CATEGORIES, SIN_CATEGORIA]).nullable(),
  comentario: z.string().nullable().default(null),
  anotadoPor: z.string().nullable().default(null),
  anotadoEn: z.string().nullable().default(null),
});

export const registroSchema = anotacionSchema.extend({
  /**
   * Por qué este mail no participa de la evaluación, si no participa.
   *
   * Hoy solo hay un motivo: es un mail saliente de MyCompany dentro del hilo. El
   * muestreo por etiqueta los trae (23 de 86 en la primera corrida) y no son
   * respuestas de prospect, así que no tienen categoría posible. Se excluyen por
   * regla determinística, no por criterio: nadie los anota.
   */
  excluidoPorRegla: z.string().nullable().default(null),
  messageId: z.string(),
  threadId: z.string(),
  from: z.string(),
  fromNombre: z.string().nullable(),
  to: z.array(z.string()),
  deliveredTo: z.array(z.string()),
  subject: z.string().nullable(),
  date: z.string(),
  /** Se guarda para la matriz de cruce. La herramienta de anotación NO lo muestra. */
  labelsGmail: z.array(z.string()),
  etiquetaDeMuestreo: z.string(),
  cuerpoLimpio: z.string(),
  cuerpoCrudo: z.string(),
  cortadoPor: z.string().nullable(),
});

export type RegistroDelDataset = z.infer<typeof registroSchema>;

export const datasetSchema = z.object({
  version: z.number(),
  generadoEn: z.string(),
  seed: z.number(),
  particion: z.enum(['muestra', 'holdout']),
  registros: z.array(registroSchema),
});

export type Dataset = z.infer<typeof datasetSchema>;

/**
 * El holdout no se lee sin pedirlo explícitamente.
 *
 * No es paranoia: si queda accesible por comodidad se va a usar durante la
 * iteración del prompt, y en ese momento deja de ser un holdout sin que nadie lo
 * decida. El flag hace que usarlo sea un acto deliberado y visible en el comando.
 */
export function cargarDataset(opciones: { holdout?: boolean; permitirHoldout?: boolean } = {}): Dataset {
  const holdout = opciones.holdout ?? false;

  if (holdout && opciones.permitirHoldout !== true) {
    throw new Error(
      'El holdout está protegido. Es el conjunto que mide si el prompt generaliza:\n' +
        'usarlo durante la iteración lo invalida para siempre, y no hay forma de saber\n' +
        'después que pasó. Si de verdad querés medir contra él, pasá --holdout-explicito.',
    );
  }

  const archivo = holdout ? ARCHIVO_HOLDOUT : ARCHIVO_MUESTRA;
  if (!fs.existsSync(archivo)) {
    throw new Error(`No existe ${archivo}. Generalo con: npm run dataset:sample`);
  }

  return datasetSchema.parse(JSON.parse(fs.readFileSync(archivo, 'utf8')));
}

export function guardarDataset(dataset: Dataset): void {
  fs.mkdirSync(DIRECTORIO, { recursive: true });
  const archivo = dataset.particion === 'holdout' ? ARCHIVO_HOLDOUT : ARCHIVO_MUESTRA;
  fs.writeFileSync(archivo, JSON.stringify(dataset, null, 2) + '\n', 'utf8');
}

/**
 * PRNG con seed (mulberry32). `Math.random()` haría que dos corridas del muestreo
 * den datasets distintos, y entonces "el prompt mejoró" no se podría distinguir de
 * "salieron otros mails".
 */
export function generadorAleatorio(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates con el generador con seed. */
export function mezclar<T>(items: readonly T[], aleatorio: () => number): T[] {
  const copia = [...items];
  for (let i = copia.length - 1; i > 0; i -= 1) {
    const j = Math.floor(aleatorio() * (i + 1));
    const a = copia[i] as T;
    const b = copia[j] as T;
    copia[i] = b;
    copia[j] = a;
  }
  return copia;
}
