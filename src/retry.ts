/**
 * Retry con backoff exponencial, compartido por todos los clientes de APIs externas.
 *
 * Vivía en `src/gmail/` cuando Gmail era el único consumidor. Se movió acá al
 * aparecer el segundo (Snov): dejarlo en `gmail/` obligaba a que Snov importara
 * desde ahí —confuso— o a copiarlo, que es peor.
 *
 * No tiene nada específico de ningún proveedor: reintenta 429, 5xx y cortes de red.
 */

export const INTENTOS_POR_DEFECTO = 5;
export const ESPERA_BASE_MS = 500;

export function estadoHttp(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };

  for (const candidato of [e.response?.status, e.status, e.code]) {
    const n = Number(candidato);
    if (Number.isFinite(n) && n >= 100 && n < 600) return n;
  }
  return undefined;
}

/** 429 y 5xx se reintentan; 4xx no (un 403 de scope no mejora reintentando). */
export function esReintentable(error: unknown): boolean {
  const status = estadoHttp(error);
  if (status === 429) return true;
  if (status !== undefined) return status >= 500;

  const codigo = (error as { code?: unknown } | null)?.code;
  return (
    typeof codigo === 'string' &&
    ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(codigo)
  );
}

export interface OpcionesDeRetry {
  intentos?: number;
  dormir?: (ms: number) => Promise<void>;
  /** Inyectable para tests: por defecto agrega jitter. */
  jitter?: () => number;
}

const dormirDefault = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function ejecutarConRetry<T>(
  fn: () => Promise<T>,
  opciones: OpcionesDeRetry = {},
): Promise<T> {
  const intentos = opciones.intentos ?? INTENTOS_POR_DEFECTO;
  const dormir = opciones.dormir ?? dormirDefault;
  const jitter = opciones.jitter ?? Math.random;

  let ultimoError: unknown;

  for (let intento = 1; intento <= intentos; intento += 1) {
    try {
      return await fn();
    } catch (error) {
      ultimoError = error;
      if (!esReintentable(error) || intento === intentos) break;

      // Jitter para que varios reintentos no se sincronicen contra la misma cuota.
      await dormir(Math.round(ESPERA_BASE_MS * 2 ** (intento - 1) * (1 + jitter())));
    }
  }

  throw ultimoError;
}
