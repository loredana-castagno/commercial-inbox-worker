import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { BootstrapEnv, GmailEnv } from '../config.js';
import type { LectorDeGmail } from './client.js';
import { GmailAuthError, mapGmailError } from './errors.js';
import { compararScopes, parseScopes } from './scopes.js';

/** Cliente OAuth sin credenciales todavía. Es el que usa `auth:gmail`. */
export function crearClienteOAuth(env: BootstrapEnv): OAuth2Client {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

/** Cliente listo para llamar a la API, con el refresh token del .env. */
export function crearClienteAutenticado(config: GmailEnv): OAuth2Client {
  const client = crearClienteOAuth(config);
  client.setCredentials({ refresh_token: config.GMAIL_REFRESH_TOKEN });
  return client;
}

let preflightHecho = false;

export interface ResultadoPreflight {
  scopesConcedidos: string[];
  /** Scopes de más que no tocan el correo. Se informan, no frenan. */
  excedentesAjenos: string[];
  /** La casilla que el token abre de verdad, según Gmail. */
  cuenta: string;
}

/** Comparación de casillas: Gmail no distingue mayúsculas. */
export function esLaMismaCuenta(concedida: string, esperada: string): boolean {
  return concedida.trim().toLowerCase() === esperada.trim().toLowerCase();
}

/**
 * Verifica, **una sola vez al arranque**, que el refresh token sirva para lo que
 * el `.env` dice: el scope configurado y la casilla configurada.
 *
 * El memo no es una optimización: es lo que garantiza que esto no se convierta en
 * una llamada por corrida si alguien lo invoca desde adentro del loop.
 */
export async function preflightDeCredenciales(
  client: OAuth2Client,
  // Se pide el lector, y no la instancia de googleapis, para que la llamada a
  // getProfile pase por el retry y por mapGmailError como todas las demás.
  lector: Pick<LectorDeGmail, 'obtenerPerfil'>,
  config: Pick<GmailEnv, 'GMAIL_SCOPE' | 'GMAIL_USER_EMAIL'>,
): Promise<ResultadoPreflight | null> {
  if (preflightHecho) return null;

  const requeridos = parseScopes(config.GMAIL_SCOPE);

  let concedidos: string[];
  try {
    // Refrescar el access token es condición necesaria pero no suficiente: un
    // token de readonly refresca sin problema. Lo que decide es tokeninfo.
    const { token } = await client.getAccessToken();
    if (!token) {
      throw new GmailAuthError(
        'consentimiento-revocado',
        'Google no devolvió un access token al refrescar. ' +
          `Rehacer el consentimiento: \`npm run auth:gmail\` con GMAIL_SCOPE=${config.GMAIL_SCOPE}.`,
      );
    }
    const info = await client.getTokenInfo(token);
    concedidos = info.scopes;
  } catch (error) {
    if (error instanceof GmailAuthError) throw error;
    throw mapGmailError(error, { scopeConfigurado: config.GMAIL_SCOPE });
  }

  const { faltantes, excedentesDeGmail, excedentesAjenos } = compararScopes(concedidos, requeridos);

  const comoRehacer =
    `Rehacer: \`npm run auth:gmail\` con GMAIL_SCOPE=${config.GMAIL_SCOPE}, y pegar el token nuevo en .env. ` +
    'Requiere a Ally: el consentimiento es sobre su cuenta.';

  if (faltantes.length > 0) {
    throw new GmailAuthError(
      'scope-insuficiente',
      `El refresh token de ${config.GMAIL_USER_EMAIL} no cubre ${faltantes.join(', ')}. ` +
        `Concedidos: ${concedidos.join(', ') || '(ninguno)'}. Configurado en GMAIL_SCOPE: ${config.GMAIL_SCOPE}. ` +
        'Pasa cuando se cambia GMAIL_SCOPE sin rehacer el consentimiento OAuth. ' +
        comoRehacer,
    );
  }

  // Un token más amplio que GMAIL_SCOPE también es un error, y no uno menor: la
  // barrera de las Fases 1-3 (CLAUDE.md #3) es que el token NO PUEDA escribir. Con
  // `modify` concedido y `readonly` configurado, esa barrera dura no existe y solo
  // quedan los flags, que son software. El caso que importa es el rollback: bajar
  // GMAIL_SCOPE a readonly después de la Fase 4 parece devolver la garantía y no lo
  // hace, porque el token sigue teniendo modify.
  if (excedentesDeGmail.length > 0) {
    throw new GmailAuthError(
      'scope-excedido',
      `El refresh token de ${config.GMAIL_USER_EMAIL} concede más acceso al correo que GMAIL_SCOPE: ` +
        `${excedentesDeGmail.join(', ')} de más. Configurado: ${config.GMAIL_SCOPE}. ` +
        'Mientras el token siga siendo más amplio, bajar GMAIL_SCOPE no reduce lo que el worker puede hacer. ' +
        comoRehacer,
    );
  }

  // Un token válido para la cuenta equivocada está tan roto como uno con el scope
  // equivocado, y hasta acá no lo detectaba nada: el flujo de OAuth lo produce con
  // un solo click de más en el selector de cuentas de Google. Peor todavía, no
  // rompe: el worker clasifica y archiva contra la casilla que no es.
  const perfil = await lector.obtenerPerfil();
  const cuenta = perfil.emailAddress ?? '';

  if (!esLaMismaCuenta(cuenta, config.GMAIL_USER_EMAIL)) {
    throw new GmailAuthError(
      'cuenta-equivocada',
      `El refresh token abre la casilla ${cuenta || '(Gmail no devolvió la dirección)'}, ` +
        `pero GMAIL_USER_EMAIL dice ${config.GMAIL_USER_EMAIL}. ` +
        'Suele pasar por elegir la cuenta equivocada en el selector de Google. ' +
        comoRehacer,
    );
  }

  preflightHecho = true;
  return { scopesConcedidos: concedidos, excedentesAjenos, cuenta };
}

/** Solo para tests: reinicia el memo del preflight. */
export function resetPreflight(): void {
  preflightHecho = false;
}
