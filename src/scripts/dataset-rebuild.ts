import { instalarManejadorDeErrores } from '../cli-errores.js';
import { loadGmailEnv } from '../config.js';
import { aplicarAnotaciones, cargarAnotaciones } from '../evals/anotaciones.js';
import { guardarDataset, type RegistroDelDataset } from '../evals/dataset.js';
import { crearClienteAutenticado, preflightDeCredenciales } from '../gmail/auth.js';
import { GmailClient } from '../gmail/client.js';
import { parsearMensaje } from '../gmail/parse.js';

/**
 * Reconstruye el dataset local desde Gmail + las anotaciones versionadas.
 *
 * Es la contrapartida de no versionar los cuerpos: `evals/dataset/anotaciones.json`
 * tiene el trabajo humano, y los mails se vuelven a traer por `messageId`. Después
 * de clonar el repo, esto es lo que hay que correr para poder usar `npm run evals`.
 *
 *   npm run dataset:rebuild
 *
 * Solo lectura sobre Gmail. Escribe la caché local, que está gitignoreada.
 */

instalarManejadorDeErrores();

const config = loadGmailEnv();
const auth = crearClienteAutenticado(config);
const client = new GmailClient(auth, { scopeConfigurado: config.GMAIL_SCOPE });
await preflightDeCredenciales(auth, client, config);

const anotaciones = cargarAnotaciones();
const generadoEn = new Date().toISOString();

for (const particion of ['muestra', 'holdout'] as const) {
  const entradas = anotaciones.entradas.filter((e) => e.particion === particion);
  if (entradas.length === 0) continue;

  const registros: RegistroDelDataset[] = [];
  let perdidos = 0;

  for (const [i, e] of entradas.entries()) {
    process.stdout.write(`\r  ${particion}: ${i + 1}/${entradas.length}`);
    try {
      const m = parsearMensaje(await client.obtenerMensaje(e.messageId));
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
        etiquetaDeMuestreo: e.etiquetaDeMuestreo,
        cuerpoLimpio: m.cuerpo,
        cuerpoCrudo: m.cuerpoCrudo,
        cortadoPor: m.limpieza.cortadoPor,
        excluidoPorRegla: e.excluidoPorRegla,
        categoriaAnotada: e.categoriaAnotada,
        comentario: e.comentario,
        anotadoPor: e.anotadoPor,
        anotadoEn: e.anotadoEn,
      });
    } catch {
      // Un mail borrado de Gmail deja un hueco: se avisa, no se inventa.
      perdidos += 1;
      console.error(`\n  ✖ ${e.messageId} ya no está en Gmail`);
    }
  }

  guardarDataset({
    version: 2,
    generadoEn,
    seed: anotaciones.seed,
    particion,
    registros: aplicarAnotaciones(registros, anotaciones, particion),
  });

  const anotados = registros.filter((r) => r.categoriaAnotada !== null).length;
  console.log(
    `\r  ${particion}: ${registros.length} mails reconstruidos, ${anotados} con anotación` +
      (perdidos > 0 ? `, ${perdidos} perdidos` : ''),
  );
}

console.log('\nListo. La caché local no se versiona; las anotaciones sí.');
