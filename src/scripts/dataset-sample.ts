import fs from 'node:fs';
import { instalarManejadorDeErrores } from '../cli-errores.js';
import { loadGmailEnv } from '../config.js';
import {
  ARCHIVO_HOLDOUT,
  ARCHIVO_MUESTRA,
  datasetSchema,
  generadorAleatorio,
  guardarDataset,
  mezclar,
  type RegistroDelDataset,
} from '../evals/dataset.js';
import { crearClienteAutenticado, preflightDeCredenciales } from '../gmail/auth.js';
import { GmailClient } from '../gmail/client.js';
import { ETIQUETAS, resolverEtiquetas } from '../gmail/etiquetas-del-dataset.js';
import { parsearMensaje } from '../gmail/parse.js';

/**
 * Muestreo estratificado para el dataset de evaluación.
 *
 * Los labels de Gmail NO son ground truth (ver SPEC.md): se usan para *encontrar*
 * los mails y para estratificar, y quedan guardados solo para poder cruzarlos
 * después contra la anotación humana. La categoría la pone una persona.
 *
 *   npm run dataset:sample
 *   npm run dataset:sample -- --seed=123
 *
 * Solo lectura sobre Gmail. Escribe evals/dataset/.
 */

const args = process.argv.slice(2);
const seed = Number(args.find((a) => a.startsWith('--seed='))?.slice('--seed='.length) ?? '20260818');
const TAMAÑO_HOLDOUT = 30;
/** De cuántos candidatos por etiqueta se sortea. Más pool = menos sesgo de recencia. */
const POOL_POR_ETIQUETA = 150;

instalarManejadorDeErrores();
const config = loadGmailEnv();
const auth = crearClienteAutenticado(config);
const client = new GmailClient(auth, { scopeConfigurado: config.GMAIL_SCOPE });
await preflightDeCredenciales(auth, client, config);

const mapa = await resolverEtiquetas(client);
const aleatorio = generadorAleatorio(seed);

async function idsDeEtiqueta(labelId: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const pagina = await client.listarMensajes({
      labelIds: [labelId],
      maxResults: Math.min(100, POOL_POR_ETIQUETA - ids.length),
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    for (const m of pagina.messages ?? []) ids.push(m.id);
    pageToken = ids.length >= POOL_POR_ETIQUETA ? undefined : (pagina.nextPageToken ?? undefined);
  } while (pageToken !== undefined);

  return ids;
}

const porEtiqueta = new Map<string, RegistroDelDataset[]>();

for (const { nombre, cuota } of ETIQUETAS) {
  const etiqueta = mapa.get(nombre.toUpperCase());
  if (etiqueta === undefined) {
    console.log(`${nombre.padEnd(18)} no existe en la casilla, se saltea`);
    continue;
  }

  const pool = await idsDeEtiqueta(etiqueta.id);
  const elegidos = mezclar(pool, aleatorio).slice(0, cuota);
  const registros: RegistroDelDataset[] = [];

  for (const id of elegidos) {
    const m = parsearMensaje(await client.obtenerMensaje(id));
    registros.push({
      messageId: m.messageId,
      threadId: m.threadId,
      from: m.from.email,
      fromNombre: m.from.nombre,
      to: m.to.map((d) => d.email),
      deliveredTo: m.deliveredTo,
      subject: m.subject,
      date: m.date.toISOString(),
      labelsGmail: m.labelIds,
      etiquetaDeMuestreo: nombre,
      cuerpoLimpio: m.cuerpo,
      cuerpoCrudo: m.cuerpoCrudo,
      cortadoPor: m.limpieza.cortadoPor,
      // Los salientes de MyCompany no son respuestas de prospect: se excluyen por
      // regla, no por criterio. Nadie los anota y no cuentan en la evaluación.
      excluidoPorRegla: /@mycompany\./i.test(m.from.email) ? 'saliente-mycompany' : null,
      categoriaAnotada: null,
      comentario: null,
      anotadoPor: null,
      anotadoEn: null,
    });
  }

  porEtiqueta.set(nombre, registros);
  console.log(
    `${nombre.padEnd(18)} pool ${String(pool.length).padStart(4)}  →  ${registros.length} muestreados`,
  );
}

// El holdout se estratifica igual que la muestra: si saliera todo de una etiqueta
// mediría otra cosa. Se aparta ANTES de que nadie mire nada.
const holdout: RegistroDelDataset[] = [];
const muestra: RegistroDelDataset[] = [];
const total = [...porEtiqueta.values()].reduce((n, r) => n + r.length, 0);

for (const [, registros] of porEtiqueta) {
  const cuantos = Math.round((registros.length / total) * TAMAÑO_HOLDOUT);
  holdout.push(...registros.slice(0, cuantos));
  muestra.push(...registros.slice(cuantos));
}

for (const [archivo, particion] of [[ARCHIVO_MUESTRA, 'muestra'], [ARCHIVO_HOLDOUT, 'holdout']] as const) {
  if (!fs.existsSync(archivo)) continue;
  const previo = datasetSchema.safeParse(JSON.parse(fs.readFileSync(archivo, 'utf8')));
  const anotados = previo.success
    ? previo.data.registros.filter((r) => r.categoriaAnotada !== null).length
    : 0;
  if (anotados > 0 && !args.includes('--forzar')) {
    throw new Error(
      `${archivo} ya tiene ${anotados} mails anotados a mano (${particion}). ` +
        'Regenerar el muestreo los borra, y la anotación humana no se regenera. ' +
        'Si de verdad querés rehacerlo, pasá --forzar.',
    );
  }
}

const generadoEn = new Date().toISOString();
guardarDataset({ version: 1, generadoEn, seed, particion: 'muestra', registros: muestra });
guardarDataset({ version: 1, generadoEn, seed, particion: 'holdout', registros: holdout });

console.log(`\nseed ${seed} — reproducible: misma seed, mismo dataset`);
console.log(`muestra: ${muestra.length} mails  → ${ARCHIVO_MUESTRA}`);
console.log(`holdout: ${holdout.length} mails  → ${ARCHIVO_HOLDOUT}`);
console.log('\nEl holdout no se toca durante la iteración del prompt.');
console.log('Siguiente paso: npm run anotar');
