import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CATEGORIES } from '../categories.js';
import { DIRECTORIO, SIN_CATEGORIA, type Dataset, type RegistroDelDataset } from './dataset.js';

/**
 * Las anotaciones, separadas del contenido de los mails.
 *
 * **Este archivo se versiona; los cuerpos no.** El dataset completo tiene 120 mails
 * reales —cuerpo, nombre y dirección— de 90 empresas de terceros: subir eso a git
 * lo deja en el historial para siempre y lo clona cada máquina. Acá quedan solo el
 * `messageId` y la decisión humana.
 *
 * Lo irreemplazable es la anotación: los cuerpos se vuelven a traer de Gmail por
 * `messageId` con `npm run dataset:rebuild`, y el muestreo es reproducible por seed.
 */

export const ARCHIVO_ANOTACIONES = path.join(DIRECTORIO, 'anotaciones.json');

const entradaSchema = z.object({
  messageId: z.string(),
  particion: z.enum(['muestra', 'holdout']),
  /** El label de Gmail del que salió. No es dato personal y sirve para la matriz. */
  etiquetaDeMuestreo: z.string(),
  excluidoPorRegla: z.string().nullable(),
  categoriaAnotada: z.enum([...CATEGORIES, SIN_CATEGORIA]).nullable(),
  comentario: z.string().nullable(),
  anotadoPor: z.string().nullable(),
  anotadoEn: z.string().nullable(),
});

export const anotacionesSchema = z.object({
  version: z.number(),
  seed: z.number(),
  entradas: z.array(entradaSchema),
});

export type Anotaciones = z.infer<typeof anotacionesSchema>;

export function cargarAnotaciones(): Anotaciones {
  if (!fs.existsSync(ARCHIVO_ANOTACIONES)) {
    throw new Error(
      `No existe ${ARCHIVO_ANOTACIONES}. Es el archivo versionado con el trabajo de anotación.`,
    );
  }
  return anotacionesSchema.parse(JSON.parse(fs.readFileSync(ARCHIVO_ANOTACIONES, 'utf8')));
}

/**
 * Vuelca las anotaciones de un dataset al archivo versionado, sin pisar las de la
 * otra partición.
 */
export function guardarAnotaciones(dataset: Dataset): void {
  fs.mkdirSync(DIRECTORIO, { recursive: true });

  const previas = fs.existsSync(ARCHIVO_ANOTACIONES)
    ? anotacionesSchema.parse(JSON.parse(fs.readFileSync(ARCHIVO_ANOTACIONES, 'utf8'))).entradas
    : [];

  const deOtrasParticiones = previas.filter((e) => e.particion !== dataset.particion);
  const propias = dataset.registros.map((r) => ({
    messageId: r.messageId,
    particion: dataset.particion,
    etiquetaDeMuestreo: r.etiquetaDeMuestreo,
    excluidoPorRegla: r.excluidoPorRegla,
    categoriaAnotada: r.categoriaAnotada,
    comentario: r.comentario,
    anotadoPor: r.anotadoPor,
    anotadoEn: r.anotadoEn,
  }));

  const contenido: Anotaciones = {
    version: 1,
    seed: dataset.seed,
    entradas: [...deOtrasParticiones, ...propias].sort((a, b) =>
      a.messageId.localeCompare(b.messageId),
    ),
  };

  fs.writeFileSync(ARCHIVO_ANOTACIONES, JSON.stringify(contenido, null, 2) + '\n', 'utf8');
}

/** Aplica las anotaciones versionadas sobre registros recién traídos de Gmail. */
export function aplicarAnotaciones(
  registros: RegistroDelDataset[],
  anotaciones: Anotaciones,
  particion: 'muestra' | 'holdout',
): RegistroDelDataset[] {
  const porId = new Map(
    anotaciones.entradas.filter((e) => e.particion === particion).map((e) => [e.messageId, e]),
  );

  return registros.map((r) => {
    const a = porId.get(r.messageId);
    if (a === undefined) return r;
    return {
      ...r,
      excluidoPorRegla: a.excluidoPorRegla,
      categoriaAnotada: a.categoriaAnotada,
      comentario: a.comentario,
      anotadoPor: a.anotadoPor,
      anotadoEn: a.anotadoEn,
    };
  });
}
