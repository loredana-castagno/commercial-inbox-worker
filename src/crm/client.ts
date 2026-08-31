import type { z } from 'zod';
import { ejecutarConRetry } from '../retry.js';
import { mapCrmError } from './errors.js';
import { consultaDeContactoSchema, type ConsultaDeContacto } from './schemas.js';

const TIMEOUT_MS = 20_000;

/** La ruta. No es `by-email` ni `upsert-from-email` (SPEC.md § Endpoints). */
const RUTA = '/api/leads/from-email';

export interface OpcionesDeClienteCrm {
  baseUrl: string;
  /** Va en el header `X-API-Key`. Del lado del CRM se llama `CRM_SERVICE_API_KEY`. */
  token: string | undefined;
  /**
   * Habilita `escribir()`. Sin esto el cliente es de solo lectura y cualquier
   * intento de escritura falla antes de tocar la red. Segunda barrera: la primera
   * es que `CrmWriter` no se puede construir sin el flag.
   */
  escrituraHabilitada?: boolean;
  fetchImpl?: typeof fetch;
  dormir?: (ms: number) => Promise<void>;
}

/**
 * Cliente HTTP del CRM.
 *
 * **Es el único camino hacia el CRM.** No se importa su Prisma client ni se abre
 * su SQLite: son dos deploy units y SQLite no tolera dos escritores (CLAUDE.md).
 *
 * Igual que en Gmail y en Snov, `#pedir` es el único punto de salida a la red: lo
 * único que aplica retry, timeout y traducción de errores.
 */
export class CrmClient {
  readonly #opciones: OpcionesDeClienteCrm;
  readonly #fetch: typeof fetch;

  constructor(opciones: OpcionesDeClienteCrm) {
    this.#opciones = opciones;
    this.#fetch = opciones.fetchImpl ?? fetch;
  }

  async #pedir<T extends z.ZodTypeAny>(
    schema: T,
    opciones: { metodo: 'GET' | 'POST'; query?: Record<string, string>; cuerpo?: unknown },
  ): Promise<z.infer<T>> {
    const url = new URL(RUTA, this.#opciones.baseUrl);
    for (const [k, v] of Object.entries(opciones.query ?? {})) url.searchParams.set(k, v);

    const operacion = `${opciones.metodo} ${RUTA}`;

    try {
      const respuesta = await ejecutarConRetry(
        async () => {
          const headers: Record<string, string> = { accept: 'application/json' };
          if (this.#opciones.token !== undefined) {
            headers['x-api-key'] = this.#opciones.token;
          }
          if (opciones.cuerpo !== undefined) headers['content-type'] = 'application/json';

          const res = await this.#fetch(url, {
            method: opciones.metodo,
            headers,
            signal: AbortSignal.timeout(TIMEOUT_MS),
            ...(opciones.cuerpo === undefined ? {} : { body: JSON.stringify(opciones.cuerpo) }),
          });

          if (!res.ok) {
            throw Object.assign(new Error(`HTTP ${res.status} en ${operacion}`), {
              status: res.status,
              cuerpo: (await res.text()).slice(0, 300),
            });
          }

          return res.json() as Promise<unknown>;
        },
        this.#opciones.dormir === undefined ? {} : { dormir: this.#opciones.dormir },
      );

      return schema.parse(respuesta) as z.infer<T>;
    } catch (error) {
      const traducido = mapCrmError(error, { operacion });
      throw traducido instanceof Error ? traducido : new Error(`Falló ${operacion}`);
    }
  }

  /**
   * Consulta si el contacto existe. **Devuelve 200 aunque no exista**, así que
   * `exists: false` es una respuesta y no un error.
   *
   * Es lectura: no pasa por `escrituraHabilitada`.
   */
  async buscarPorEmail(email: string): Promise<ConsultaDeContacto> {
    return this.#pedir(consultaDeContactoSchema, { metodo: 'GET', query: { email } });
  }

  /**
   * POST a la ruta de alta. Lo usa `CrmWriter` y nadie más.
   *
   * Falla en seco si el cliente no se construyó con `escrituraHabilitada`. Que sea
   * un throw y no un no-op es deliberado: un no-op reportaría éxito sobre algo que
   * no pasó.
   */
  async escribir<T extends z.ZodTypeAny>(schema: T, cuerpo: unknown): Promise<z.infer<T>> {
    if (this.#opciones.escrituraHabilitada !== true) {
      throw new Error(
        `Escritura en el CRM deshabilitada: se intentó POST ${RUTA} con un cliente de ` +
          'solo lectura. Se habilita con EXTERNAL_WRITE_ENABLED=true.',
      );
    }
    return this.#pedir(schema, { metodo: 'POST', cuerpo });
  }
}
