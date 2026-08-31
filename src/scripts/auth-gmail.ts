import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { loadBootstrapEnv } from '../config.js';
import { leerVariable, reemplazarVariable } from '../env-file.js';
import { crearClienteOAuth } from '../gmail/auth.js';
import { parseScopes } from '../gmail/scopes.js';

/**
 * Obtiene el refresh token de Gmail.
 *
 * Lo corre Ally sobre su propia casilla, así que la salida está escrita para
 * alguien que no trabaja en este repo. Importa `loadBootstrapEnv` y no
 * `getConfig` a propósito: este script existe justamente para conseguir el
 * refresh token que el env completo exige.
 *
 * Hay dos caminos para recibir el código, porque el primero falla en el escenario
 * más común de todos:
 *
 *  A) El servidor local escucha en GOOGLE_REDIRECT_URI. Solo funciona si el
 *     navegador corre en ESTA máquina: Google redirige a `localhost`, y el
 *     `localhost` del navegador de Ally es su propia computadora, no ésta.
 *  B) Pegar a mano la URL a la que quedó el navegador. Cubre el caso de arriba y
 *     el de "la página no se puede abrir" después de autorizar, que es un flujo
 *     exitoso con un final feo: el código está en esa URL.
 */

const env = loadBootstrapEnv();
const redirect = new URL(env.GOOGLE_REDIRECT_URI);
const puerto = Number(redirect.port === '' ? '80' : redirect.port);
const scopes = parseScopes(env.GMAIL_SCOPE);

const args = process.argv.slice(2);
/** Con --mostrar-token vuelve al comportamiento viejo: imprimir para copiar. */
const soloMostrar = args.includes('--mostrar-token');

/**
 * Canje directo, sin servidor ni navegador:
 *
 *   npm run auth:gmail -- --code="http://localhost:3100/oauth/callback?code=4/0A..."
 *
 * Es para el caso más común de todos: Google autorizó bien, redirigió a
 * localhost, y el navegador mostró "localhost refused to connect" porque el
 * script ya no estaba corriendo. La autorización fue exitosa igual — el código
 * está en la barra de direcciones y vale unos minutos. Sin esto hay que levantar
 * el servidor de nuevo solo para pegarle la URL.
 */
const codigoDirecto = args.find((a) => a.startsWith('--code='))?.slice('--code='.length);

const MINUTOS_DE_ESPERA = Number(process.env.AUTH_TIMEOUT_MINUTES ?? '15');
const ARCHIVO_URL = path.join(process.cwd(), 'auth-url.txt');

const client = crearClienteOAuth(env);
const url = client.generateAuthUrl({
  access_type: 'offline',
  // `consent`: sin esto Google no reemite el refresh token si la cuenta ya dio
  // consentimiento antes, y la respuesta vuelve sin refresh_token — el script
  // parece andar y no sirve.
  // `select_account`: fuerza el selector en vez de usar la sesión ya abierta en
  // el navegador, que es como se termina autorizando con la cuenta equivocada.
  prompt: 'consent select_account',
  // Preselecciona la casilla de destino en ese selector.
  login_hint: env.GMAIL_USER_EMAIL,
  scope: scopes,
});

fs.writeFileSync(ARCHIVO_URL, url + '\n', 'utf8');

if (codigoDirecto === undefined) {
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(' Autorización de Gmail para el worker de triage (commercial-inbox-worker)');
console.log('══════════════════════════════════════════════════════════════');
console.log('');
console.log('Qué vas a autorizar:');
for (const scope of scopes) {
  const esLectura = scope.includes('readonly') || scope.includes('metadata');
  console.log(`  • ${scope}`);
  console.log(
    `    ${esLectura ? 'Solo lectura: no puede modificar ni borrar nada.' : 'ATENCIÓN: permite modificar mails (labels, archivar).'}`,
  );
}
console.log('');
console.log(`Cuenta a elegir en la pantalla de Google: ${env.GMAIL_USER_EMAIL}`);
console.log('Si aparece un aviso de app no verificada, es esperable (app Internal).');
console.log('');
console.log('IMPORTANTE: el navegador tiene que ser el de ESTA computadora.');
console.log('Si Ally autoriza desde su propia máquina, el redirect a localhost');
console.log('apunta a la de ella y este script no se entera. En ese caso, usá el');
console.log('paso 3 de abajo.');
console.log('');
console.log('1) Abriendo el navegador. Si no se abre solo, el link está en:');
console.log(`   ${ARCHIVO_URL}`);
console.log('');
console.log(`2) Esperando la respuesta en ${redirect.origin}${redirect.pathname}`);
console.log(`   (hasta ${MINUTOS_DE_ESPERA} minutos; se cambia con AUTH_TIMEOUT_MINUTES)`);
console.log('');
console.log('3) SI EL NAVEGADOR TERMINÓ EN UNA PÁGINA DE ERROR después de autorizar:');
console.log('   copiá de la barra de direcciones la URL completa (la que empieza con');
console.log(`   ${redirect.origin}${redirect.pathname}?code=...) y pegala acá abajo + Enter.`);
console.log('');
}

/**
 * Abre el navegador con la URL de consentimiento.
 *
 * En Windows la URL **tiene que ir entre comillas y con
 * `windowsVerbatimArguments`**: `cmd` interpreta cada `&` como separador de
 * comandos, así que sin comillas al navegador le llega la URL cortada en el
 * primer parámetro y Google responde "Required parameter is missing:
 * response_type". El primer `""` es el título de ventana que `start` se come.
 */
function abrirNavegador(destino: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', `"${destino}"`], {
        stdio: 'ignore',
        detached: true,
        windowsVerbatimArguments: true,
      }).unref();
      return;
    }

    // En POSIX no hay shell de por medio: el argumento va tal cual.
    const comando = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(comando, [destino], { stdio: 'ignore', detached: true }).unref();
  } catch {
    console.log('(No se pudo abrir el navegador solo: abrí el link a mano.)');
  }
}

/**
 * Escribe el token en el .env, en vez de imprimirlo para copiar a mano.
 *
 * El paso manual falló tres veces seguidas y, además, hacía que la credencial
 * quedara en el scrollback de la terminal y viajara por donde no debería. Se
 * guarda una copia del .env antes de tocarlo, y se relee después para confirmar.
 */
function guardarTokenEnEnv(token: string): void {
  const rutaEnv = path.join(process.cwd(), '.env');

  if (!fs.existsSync(rutaEnv)) {
    console.log('No encontré un archivo .env en este directorio.');
    console.log('Copiá .env.example a .env y volvé a correr esto, o usá --mostrar-token.');
    return;
  }

  const original = fs.readFileSync(rutaEnv, 'utf8');
  const respaldo = `${rutaEnv}.bak`;
  fs.writeFileSync(respaldo, original, 'utf8');

  fs.writeFileSync(rutaEnv, reemplazarVariable(original, 'GMAIL_REFRESH_TOKEN', token), 'utf8');

  const guardado = leerVariable(fs.readFileSync(rutaEnv, 'utf8'), 'GMAIL_REFRESH_TOKEN');
  if (guardado !== token) {
    console.log('No se pudo escribir el token en .env. Se restauró la copia previa.');
    fs.writeFileSync(rutaEnv, original, 'utf8');
    console.log('Corré de nuevo con --mostrar-token para pegarlo a mano.');
    return;
  }

  console.log(`✔ Token escrito en ${rutaEnv}`);
  console.log(`  (copia del anterior en ${path.basename(respaldo)})`);
  console.log('  No hace falta copiar ni pegar nada.');
  console.log('');
  console.log(`  GMAIL_SCOPE quedó en: ${env.GMAIL_SCOPE}`);
}

let terminado = false;
let latido: NodeJS.Timeout | undefined;

function terminar(codigo: number): void {
  if (terminado) return;
  terminado = true;

  // Sin esto el script sigue imprimiendo "... esperando" después de haber
  // impreso el token, que es justo el momento en que uno cree que falló.
  if (latido !== undefined) clearInterval(latido);
  process.stdin.pause();

  server.close();
  rl.close();
  try {
    fs.unlinkSync(ARCHIVO_URL);
  } catch {
    /* si no está, mejor */
  }
  process.exitCode = codigo;
}

async function canjearCodigo(code: string): Promise<void> {
  try {
    const { tokens } = await client.getToken(code);

    if (tokens.refresh_token === undefined || tokens.refresh_token === null) {
      console.error('\nGoogle no devolvió refresh token.');
      console.error('Suele pasar cuando ya había un consentimiento previo activo.');
      console.error('Revocá el acceso en https://myaccount.google.com/permissions');
      console.error('y volvé a correr el script.');
      terminar(1);
      return;
    }

    console.log('');
    console.log('══════════════════════════════════════════════════════════════');
    console.log(' Refresh token obtenido');
    console.log('══════════════════════════════════════════════════════════════');
    console.log('');

    if (soloMostrar) {
      console.log('Pegá esta línea en el archivo .env:');
      console.log('');
      console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log('');
      console.log('El token NO se manda por Slack ni por mail: va directo al .env.');
    } else {
      guardarTokenEnEnv(tokens.refresh_token);
    }

    console.log('');
    console.log('Para verificar que quedó bien:  npm run gmail:peek');
    console.log('');
    terminar(0);
  } catch (e) {
    console.error('\nNo se pudo canjear el código por un token:', e);
    console.error('Si el código ya se usó una vez, hay que rehacer la autorización.');
    terminar(1);
  }
}

/** Acepta tanto la URL de redirección completa como el `code` pelado. */
function extraerCodigo(entrada: string): string | null {
  const texto = entrada.trim();
  if (texto === '') return null;

  if (texto.startsWith('http://') || texto.startsWith('https://')) {
    try {
      return new URL(texto).searchParams.get('code');
    } catch {
      return null;
    }
  }

  return texto;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.on('line', (linea) => {
  const code = extraerCodigo(linea);
  if (code === null) {
    console.log('No encontré un code ahí. Pegá la URL completa, o solo el valor de code=.');
    return;
  }
  console.log('Código recibido a mano, canjeando...');
  void canjearCodigo(code);
});

const server = http.createServer((req, res) => {
  const pedido = new URL(req.url ?? '/', redirect.origin);

  if (pedido.pathname !== redirect.pathname) {
    // Loguearlo sirve para distinguir "el navegador no llegó nunca" de "llegó a
    // otra ruta": si acá aparece /favicon.ico, la conexión local funciona.
    console.log(`(pedido ignorado a ${pedido.pathname})`);
    res.writeHead(404).end('No es acá.');
    return;
  }

  const error = pedido.searchParams.get('error');
  const code = pedido.searchParams.get('code');

  if (error !== null) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>Autorización cancelada</h1><p>Podés cerrar esta pestaña.</p>');
    console.error(`\nGoogle devolvió un error: ${error}`);
    console.error('Si fue sin querer, volvé a correr el script.');
    terminar(1);
    return;
  }

  if (code === null) {
    res.writeHead(400).end('Falta el code.');
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<h1>Listo</h1><p>Ya podés cerrar esta pestaña y volver a la terminal.</p>');
  void canjearCodigo(code);
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nEl puerto ${puerto} está ocupado por otro proceso.`);
    console.error('Cerralo, o cambiá GOOGLE_REDIRECT_URI en .env y en Google Cloud Console');
    console.error('(los dos valores tienen que coincidir carácter por carácter).');
  } else {
    console.error('\nNo se pudo levantar el servidor local:', e.message);
  }
  terminar(1);
});

if (codigoDirecto !== undefined) {
  const code = extraerCodigo(codigoDirecto);
  if (code === null) {
    console.error('No encontré un code en lo que pasaste. Pegá la URL completa entre comillas.');
    process.exit(1);
  }
  console.log('Canjeando el código...');
  await canjearCodigo(code);
} else {
server.listen(puerto, () => {
  abrirNavegador(url);

  let minutos = 0;
  latido = setInterval(() => {
    minutos += 1;
    if (minutos >= MINUTOS_DE_ESPERA) {
      console.error('\nSe agotó la espera y no llegó ningún código.');
      console.error('Si el navegador llegó a la pantalla de Google y autorizaste,');
      console.error('el problema es el redirect: usá el paso 3 (pegar la URL a mano).');
      terminar(1);
      return;
    }
    console.log(`   ... esperando (${minutos}/${MINUTOS_DE_ESPERA} min)`);
  }, 60_000);
  latido.unref();
});
}
