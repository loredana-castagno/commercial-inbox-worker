import { instalarManejadorDeErrores } from '../cli-errores.js';
import { loadGmailEnv } from '../config.js';
import { crearClienteAutenticado, preflightDeCredenciales } from '../gmail/auth.js';
import { GmailClient } from '../gmail/client.js';
import { parsearMensaje } from '../gmail/parse.js';

/**
 * Imprime los últimos N mensajes del inbox ya parseados y con el citado limpio,
 * para revisar el stripping a ojo sobre mails reales antes de que nada de esto
 * llegue al prompt del clasificador.
 *
 * Solo lectura: no toca la base ni escribe en Gmail.
 *
 *   npm run gmail:peek -- 10 --crudo
 */

const args = process.argv.slice(2);
const cantidad = Number(args.find((a) => /^\d+$/.test(a)) ?? '5');
const mostrarCrudo = args.includes('--crudo');

/**
 * Búsqueda de Gmail. Sin esto el peek solo ve el INBOX, y el INBOX es justo donde
 * NO están las respuestas a campañas: los filtros ya las etiquetaron y archivaron.
 *
 *   npm run gmail:peek -- 10 --crudo --q="label:\"No thanks\""
 *   npm run gmail:peek -- 10 --crudo --q="from:mailer-daemon"
 */
const consulta = args.find((a) => a.startsWith('--q='))?.slice('--q='.length);

// Solo el env de lectura: pedir la key de Anthropic o el token de Snov para imprimir
// un mail en pantalla es la clase de fricción que termina en valores inventados.
instalarManejadorDeErrores();
const config = loadGmailEnv();
const auth = crearClienteAutenticado(config);
const client = new GmailClient(auth, { scopeConfigurado: config.GMAIL_SCOPE });

const preflight = await preflightDeCredenciales(auth, client, config);
if (preflight) {
  console.log(`Cuenta verificada: ${preflight.cuenta}`);
  console.log(`Scopes concedidos: ${preflight.scopesConcedidos.join(', ')}`);
  if (preflight.excedentesAjenos.length > 0) {
    console.log(
      `Scopes de más, ajenos al correo: ${preflight.excedentesAjenos.join(', ')} (no dan acceso a mails).`,
    );
  }
}

const lista = await client.listarMensajes(
  consulta === undefined
    ? { labelIds: ['INBOX'], maxResults: cantidad }
    : { q: consulta, maxResults: cantidad },
);
const ids = (lista.messages ?? []).map((m) => m.id);

console.log(
  `\nCasilla: ${config.GMAIL_USER_EMAIL} — ${ids.length} mensajes` +
    ` (${consulta === undefined ? 'INBOX' : `q: ${consulta}`})\n`,
);

for (const id of ids) {
  const m = parsearMensaje(await client.obtenerMensaje(id));

  console.log('─'.repeat(78));
  console.log(`de:      ${m.from.nombre ?? '(sin nombre)'} <${m.from.email}>`);
  // El alias de destino no dice de qué campaña vino (eso sale de Snov), pero sí
  // qué alias reciben tráfico: es el insumo de MYCOMPANY_OWN_ADDRESSES en Fase 4.
  console.log(`para:    ${m.to.map((d) => d.email).join(', ') || '(sin To)'}`);
  if (m.deliveredTo.length > 0) console.log(`entrega: ${m.deliveredTo.join(', ')}`);
  console.log(`asunto:  ${m.subject ?? '(sin asunto)'}`);
  console.log(`fecha:   ${m.date.toISOString()}`);
  console.log(`labels:  ${m.labelIds.join(', ') || '(ninguno)'}`);
  console.log(
    `parseo:  ${m.formato} | cortado por: ${m.limpieza.cortadoPor ?? 'nada'} | ` +
      `firma: ${m.limpieza.firmaQuitada ? 'sí' : 'no'} | líneas quitadas: ${m.limpieza.lineasQuitadas}`,
  );

  if (mostrarCrudo) {
    console.log('\n--- crudo ---');
    console.log(m.cuerpoCrudo || '(vacío)');
  }

  console.log('\n--- limpio (esto es lo que vería el clasificador) ---');
  console.log(m.cuerpo === '' ? '(vacío: el mensaje era todo citado o adjuntos)' : m.cuerpo);
  console.log('');
}

console.log('─'.repeat(78));
console.log('Revisar: ¿quedó algo del pitch de MyCompany abajo? ¿se cortó la respuesta real?');
