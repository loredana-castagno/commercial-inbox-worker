import { estadoHttp } from '../retry.js';

/**
 * Errores de Snov traducidos a algo accionable.
 *
 * El caso que motiva esto: **Snov devuelve 403 cuando la ruta existe pero el
 * método es el equivocado.** `GET /v1/get-prospects-by-email` da 403 y el mismo
 * path con POST da 200. Leído literal, ese 403 manda a buscar permisos o plan
 * donde no hay ningún problema — nos pasó al explorar la API.
 */
export class SnovError extends Error {
  readonly kind: 'credenciales' | 'metodo-o-ruta' | 'cuota' | 'desconocido';
  readonly status: number | undefined;

  constructor(
    kind: SnovError['kind'],
    message: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, options);
    this.name = 'SnovError';
    this.kind = kind;
    this.status = options?.status;
  }
}

export function mapSnovError(error: unknown, ctx: { operacion: string }): unknown {
  const status = estadoHttp(error);
  if (status === undefined) return error;

  if (status === 401) {
    return new SnovError(
      'credenciales',
      `Snov rechazó las credenciales en ${ctx.operacion}. Revisar SNOV_CLIENT_ID y ` +
        'SNOV_CLIENT_SECRET en .env: se regeneran desde app.snov.io/account/api.',
      { cause: error, status },
    );
  }

  if (status === 403) {
    return new SnovError(
      'metodo-o-ruta',
      `Snov devolvió 403 en ${ctx.operacion}. En esta API un 403 suele significar ` +
        '"la ruta existe pero el método no es el correcto", no un problema de permisos: ' +
        'verificar GET vs POST antes de tocar el plan o las credenciales.',
      { cause: error, status },
    );
  }

  if (status === 429) {
    return new SnovError(
      'cuota',
      `Snov limitó la tasa en ${ctx.operacion}. La API no informa cuota por header, ` +
        'así que el único freno es el retry.',
      { cause: error, status },
    );
  }

  return error;
}
