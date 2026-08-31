import fs from 'node:fs';
import path from 'node:path';
import { instalarManejadorDeErrores } from '../cli-errores.js';
import { loadGmailEnv } from '../config.js';
import { crearClienteAutenticado, preflightDeCredenciales } from '../gmail/auth.js';
import { GmailClient } from '../gmail/client.js';
import { ETIQUETAS, resolverEtiquetas } from '../gmail/etiquetas-del-dataset.js';
import { parsearMensaje, type MensajeParseado } from '../gmail/parse.js';

/**
 * Mina el criterio de Ally a partir de sus propias respuestas.
 *
 * La idea: las etiquetas de Gmail las puso un filtro por keywords, así que
 * aprender de ellas es aprender el criterio que estamos reemplazando. Pero cuando
 * Ally responde, **elige una plantilla, y esa elección es una clasificación hecha
 * por una persona mirando el mail**. Eso sí es señal.
 *
 * El script agrupa sus respuestas en familias de plantilla y cruza cada familia
 * contra la etiqueta del hilo. Una familia que cae siempre en la misma etiqueta es
 * una regla implícita que conviene tener escrita en el SPEC.
 *
 * Límites, para no sobrevender esto:
 *  - Solo cubre hilos que ella respondió. UNSUBSCRIBE y UNDELIVERABLE no se
 *    responden nunca, así que ahí no hay nada que minar.
 *  - Es la categoría *implícita* en la respuesta, no una etiqueta declarada. Si
 *    usó la plantilla equivocada, esto aprende el error.
 *  - Sirve para ampliar cobertura y descubrir criterios no verbalizados, NO para
 *    medir precisión. La medición sigue siendo el dataset anotado y el holdout.
 *
 *   npm run analizar:plantillas
 *   npm run analizar:plantillas -- 60          # mensajes por etiqueta
 *   npm run analizar:plantillas -- --json      # a evals/plantillas.json
 *
 * Solo lectura: no toca la base ni Gmail.
 */

const args = process.argv.slice(2);
const porEtiqueta = Number(args.find((a) => /^\d+$/.test(a)) ?? '40');
const comoJson = args.includes('--json');

/** Dos respuestas son de la misma familia si comparten esta fracción de tokens. */
const UMBRAL_SIMILITUD = 0.6;
/** Cuántos tokens del arranque se comparan. Las plantillas divergen después. */
const TOKENS_A_COMPARAR = 25;

instalarManejadorDeErrores();
const config = loadGmailEnv();
const auth = crearClienteAutenticado(config);
const client = new GmailClient(auth, { scopeConfigurado: config.GMAIL_SCOPE });
await preflightDeCredenciales(auth, client, config);

const mapa = await resolverEtiquetas(client);

/**
 * Normaliza para comparar: saca el saludo con nombre propio, la firma, los roles
 * y los números. Lo que queda es el esqueleto de la plantilla.
 */
function tokensDePlantilla(cuerpo: string): string[] {
  const sinFirma = cuerpo.split(/\n\s*(?:Best|Regards|Thanks|Saludos|Cheers)\b/i)[0] ?? cuerpo;

  return sinFirma
    .replace(/^(Hi|Hello|Hey|Hola|Dear)\s+[^,\n]{1,30}[,.]?/i, '')
    .toLowerCase()
    .replace(/[^a-záéíóúñü\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .slice(0, TOKENS_A_COMPARAR);
}

function similitud(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let comunes = 0;
  for (const t of setA) if (setB.has(t)) comunes += 1;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : comunes / union;
}

interface Respuesta {
  mensaje: MensajeParseado;
  etiqueta: string;
  tokens: string[];
}

interface Familia {
  representante: Respuesta;
  miembros: Respuesta[];
}

const respuestas: Respuesta[] = [];

for (const { nombre } of ETIQUETAS) {
  const etiqueta = mapa.get(nombre.toUpperCase());
  if (etiqueta === undefined) continue;

  const lista = await client.listarMensajes({ labelIds: [etiqueta.id], maxResults: porEtiqueta });
  let propios = 0;

  for (const { id } of lista.messages ?? []) {
    const m = parsearMensaje(await client.obtenerMensaje(id));
    if (!/@mycompany\./i.test(m.from.email)) continue;
    // Solo respuestas DENTRO del hilo. El mail que abre el hilo es el envío de la
    // campaña: sale de la misma dirección, pero es la plantilla de outbound, no
    // una clasificación. Sin este filtro las familias grandes son la campaña.
    if (m.enRespuestaA === null && m.referencias.length === 0) continue;
    if (m.cuerpo.trim().length < 40) continue;

    propios += 1;
    respuestas.push({ mensaje: m, etiqueta: nombre, tokens: tokensDePlantilla(m.cuerpo) });
  }

  console.error(`${nombre.padEnd(18)} ${propios} respuestas de Ally (dentro del hilo) sobre ${lista.messages?.length ?? 0} mensajes`);
}

// Agrupamiento voraz: cada respuesta cae en la primera familia parecida, o abre una.
const familias: Familia[] = [];
for (const r of respuestas) {
  const familia = familias.find((f) => similitud(f.representante.tokens, r.tokens) >= UMBRAL_SIMILITUD);
  if (familia) familia.miembros.push(r);
  else familias.push({ representante: r, miembros: [r] });
}

familias.sort((a, b) => b.miembros.length - a.miembros.length);

/** A qué categoría del SPEC apunta cada etiqueta, cuando apunta a alguna. */
const EQUIVALENCIA: Record<string, string> = {
  'NO THANKS DRIP': 'NO_THANKS',
  'NOT NOW DRIP': 'NOT_NOW',
  'NOT NOW TWO DRIP': 'NOT_NOW',
  'COLD (LAST TRY)': 'NOT_NOW',
  UNSUBSCRIBE: 'UNSUBSCRIBE',
  REFERRAL: 'REFERRAL',
  HOT: 'HOT',
  OOO: 'OOO',
  UNDELIVERABLE: 'UNDELIVERABLE',
  'EMAIL MODIFIED': 'EMAIL_MODIFIED',
};

/** NO_THANKS y NOT_NOW son hermanas (SPEC.md): mezclarlas no rompe la señal. */
const HERMANAS = new Set(['NO_THANKS', 'NOT_NOW']);

function resumenDeFamilia(f: Familia) {
  const etiquetas = new Map<string, number>();
  for (const m of f.miembros) etiquetas.set(m.etiqueta, (etiquetas.get(m.etiqueta) ?? 0) + 1);

  const categorias = new Map<string, number>();
  for (const [e, n] of etiquetas) {
    const c = EQUIVALENCIA[e] ?? 'OTHER';
    categorias.set(c, (categorias.get(c) ?? 0) + n);
  }

  const ordenadas = [...categorias.entries()].sort((a, b) => b[1] - a[1]);
  const dominante = ordenadas[0];
  const total = f.miembros.length;

  // Si toda la dispersión es entre categorías hermanas, la familia es consistente.
  const soloHermanas = ordenadas.every(([c]) => HERMANAS.has(c));
  const pureza = soloHermanas ? 1 : (dominante?.[1] ?? 0) / total;

  return {
    n: total,
    etiquetas: Object.fromEntries(etiquetas),
    categoriaImplicita: soloHermanas ? 'NO_THANKS/NOT_NOW' : (dominante?.[0] ?? '?'),
    pureza,
    texto: f.representante.mensaje.cuerpo.split('\n').filter((l) => l.trim() !== '').slice(0, 2).join(' '),
  };
}

const resumen = familias.map(resumenDeFamilia);

if (comoJson) {
  const destino = path.join(process.cwd(), 'evals', 'plantillas.json');
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, JSON.stringify({ porEtiqueta, familias: resumen }, null, 2) + '\n', 'utf8');
  console.log(`escrito: ${destino}`);
} else {
  console.log(`\n${respuestas.length} respuestas de Ally → ${familias.length} familias de plantilla\n`);
  console.log('n   pureza  categoría implícita   etiquetas del hilo');
  console.log('─'.repeat(100));

  for (const f of resumen) {
    if (f.n < 2) continue;
    const etiquetas = Object.entries(f.etiquetas).map(([e, n]) => `${e}:${n}`).join(' ');
    console.log(
      String(f.n).padEnd(4) +
        `${(f.pureza * 100).toFixed(0)}%`.padStart(6) +
        '  ' +
        f.categoriaImplicita.padEnd(21) +
        etiquetas,
    );
    console.log(`      "${f.texto.slice(0, 110)}..."`);
  }

  const sueltas = resumen.filter((f) => f.n === 1).length;
  console.log(`\n${sueltas} familias de un solo mail (respuestas escritas a mano, no plantilla).`);
  console.log(
    'Pureza 100% = todas las respuestas de esa plantilla caen en la misma categoría:\n' +
      'eso es una regla implícita de Ally que conviene escribir en el SPEC.',
  );
}
