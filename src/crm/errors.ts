import { estadoHttp } from '../retry.js';

/**
 * Errores del CRM traducidos a algo accionable.
 *
 * Los dos casos que motivan esto son de configuración, no de datos, y los dos
 * pasan al arrancar contra un servidor mal apuntado:
 *
 * - **401**: la ruta está protegida por dos capas independientes (`proxy.ts` y el
 *   handler). Un 401 con la key puesta suele significar que se agregó la ruta a
 *   `API_KEY_PATHS` pero no se tocó el handler.
 * - **403**: un caller de servicio no puede mandar `accountEmail`. Si aparece, es
 *   que alguien lo agregó al payload — y el tipo de `PayloadDeContacto` está hecho
 *   justamente para que no se pueda.
 */
export class CrmError extends Error {
  readonly kind: 'credenciales' | 'auth-a-medias' | 'campo-prohibido' | 'desconocido';
  readonly status: number | undefined;

  constructor(
    kind: CrmError['kind'],
    message: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, options);
    this.name = 'CrmError';
    this.kind = kind;
    this.status = options?.status;
  }
}

export function mapCrmError(error: unknown, ctx: { operacion: string }): unknown {
  const status = estadoHttp(error);
  if (status === undefined) return error;

  if (status === 401) {
    return new CrmError(
      'auth-a-medias',
      `El CRM devolvió 401 en ${ctx.operacion}. Con CRM_SERVICE_TOKEN puesto, el 401 ` +
        'casi siempre es que la ruta se agregó a API_KEY_PATHS en proxy.ts pero el handler ' +
        'sigue exigiendo token.email: son dos capas y hay que abrir las dos. ' +
        'Si el token no está puesto, es eso.',
      { cause: error, status },
    );
  }

  if (status === 403) {
    return new CrmError(
      'campo-prohibido',
      `El CRM devolvió 403 en ${ctx.operacion}. Para un caller de servicio, mandar ` +
        '`accountEmail` da 403 siempre: el fetch por IMAP resuelve el buzón con el app ' +
        'password guardado de ese usuario, así que permitirlo convertiría esta key en una ' +
        'de "leer cualquier casilla". El payload no debería incluir ese campo.',
      { cause: error, status },
    );
  }

  return error;
}
