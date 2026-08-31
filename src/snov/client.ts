import type { z } from 'zod';
import { ejecutarConRetry } from '../retry.js';
import { mapSnovError } from './errors.js';
import {
  listasDeDoNotEmailSchema,
  listasDelUsuarioSchema,
  respuestaDeProspectsSchema,
  resultadoDeVerificacionSchema,
  tokenSchema,
  verificacionIniciadaSchema,
} from './schemas.js';

const TIMEOUT_MS = 20_000;
/** El token dura 3600s. Se renueva antes para no correr una carrera con el vencimiento. */
const MARGEN_DE_RENOVACION_MS = 5 * 60 * 1000;

export interface OpcionesDeClienteSnov {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  /**
   * Habilita `escribir()`. Sin esto el cliente es de solo lectura y cualquier
   * intento de escritura falla antes de tocar la red.
   *
   * Es la **segunda** barrera, no la única: la primera es que `SnovWriter` no se
   * puede construir sin el flag. Ésta cubre el camino que la otra no puede — que
   * alguien llame a `escribir()` directo desde la lógica de negocio.
   */
  escrituraHabilitada?: boolean;
  /** Inyectables para testear sin red ni esperas reales. */
  fetchImpl?: typeof fetch;
  ahora?: () => number;
  dormir?: (ms: number) => Promise<void>;
}

/**
 * Cliente de Snov.
 *
 * **De solo lectura salvo que se lo habilite explícitamente.** `escribir()`
 * existe, pero tira antes de tocar la red si el cliente no se construyó con
 * `escrituraHabilitada`. Las escrituras concretas viven en `SnovWriter`, que
 * tampoco se puede construir sin el flag.
 *
 * Son dos barreras sobre el mismo valor de config a propósito: la de `SnovWriter`
 * es la ergonómica —el código normal ni ve los métodos— y ésta es la que cubre el
 * bypass, que es la pregunta que manda (CLAUDE.md #6).
 *
 * Igual que en Gmail, `#pedir` es el único camino de salida hacia la red: es lo
 * único que aplica retry, timeout y traducción de errores.
 */
export class SnovClient {
  readonly #opciones: OpcionesDeClienteSnov;
  readonly #fetch: typeof fetch;
  readonly #ahora: () => number;

  #token: string | undefined;
  #venceEn = 0;
  /** Renovación en vuelo: diez llamadas en paralelo piden un token, no diez. */
  #renovacion: Promise<string> | undefined;

  constructor(opciones: OpcionesDeClienteSnov) {
    this.#opciones = opciones;
    this.#fetch = opciones.fetchImpl ?? fetch;
    this.#ahora = opciones.ahora ?? Date.now;
  }

  async #obtenerToken(): Promise<string> {
    if (this.#token !== undefined && this.#ahora() < this.#venceEn) return this.#token;
    if (this.#renovacion !== undefined) return this.#renovacion;

    this.#renovacion = (async () => {
      const datos = await this.#pedir('oauth/access_token', tokenSchema, {
        metodo: 'POST',
        cuerpo: {
          grant_type: 'client_credentials',
          client_id: this.#opciones.clientId,
          client_secret: this.#opciones.clientSecret,
        },
        sinToken: true,
      });

      this.#token = datos.access_token;
      this.#venceEn = this.#ahora() + datos.expires_in * 1000 - MARGEN_DE_RENOVACION_MS;
      return datos.access_token;
    })();

    try {
      return await this.#renovacion;
    } finally {
      this.#renovacion = undefined;
    }
  }

  /**
   * Único camino de salida: retry, timeout, parseo con Zod y traducción de errores.
   *
   * Dos detalles que no son uniformes en esta API y por eso son opciones:
   *
   * - **`version`.** Casi todo vive en `/v1/`, pero no todo: las listas de
   *   do-not-email se leen en `/v2/blacklists`. Asumir `/v1` para todo daba un
   *   403 que parecía de permisos (SPEC.md § do-not-email).
   * - **`formulario`.** El default es JSON, que es lo que aceptan las rutas que
   *   usamos. `do-not-email-list` **no**: espera `application/x-www-form-urlencoded`
   *   con el `access_token` en el cuerpo, como muestran los ejemplos de la doc.
   *   Mandarle JSON devuelve `400 "Emails list is empty"` — el servidor parsea el
   *   cuerpo como formulario, no encuentra nada, y reporta la lista vacía.
   */
  async #pedir<T extends z.ZodTypeAny>(
    ruta: string,
    schema: T,
    opciones: {
      metodo: 'GET' | 'POST';
      cuerpo?: unknown;
      sinToken?: boolean;
      version?: 'v1' | 'v2';
      /** Campos form-encoded. Un array se manda repitiendo la clave. */
      formulario?: Record<string, string | readonly string[]>;
    },
  ): Promise<z.infer<T>> {
    const url = `${this.#opciones.apiBase.replace(/\/+$/, '')}/${opciones.version ?? 'v1'}/${ruta}`;

    try {
      const respuesta = await ejecutarConRetry(
        async () => {
          const esFormulario = opciones.formulario !== undefined;
          const headers: Record<string, string> = {
            'content-type': esFormulario
              ? 'application/x-www-form-urlencoded'
              : 'application/json',
          };

          const token = opciones.sinToken === true ? undefined : await this.#obtenerToken();
          if (token !== undefined) headers['authorization'] = `Bearer ${token}`;

          let cuerpo: string | undefined;
          if (opciones.formulario !== undefined) {
            const form = new URLSearchParams();
            // El token va **también** en el cuerpo: es lo que documenta Snov para
            // estas rutas. El header se manda igual y no molesta.
            if (token !== undefined) form.append('access_token', token);
            for (const [clave, valor] of Object.entries(opciones.formulario)) {
              for (const v of Array.isArray(valor) ? valor : [valor as string]) {
                form.append(clave, v);
              }
            }
            cuerpo = form.toString();
          } else if (opciones.cuerpo !== undefined) {
            cuerpo = JSON.stringify(opciones.cuerpo);
          }

          const res = await this.#fetch(url, {
            method: opciones.metodo,
            headers,
            signal: AbortSignal.timeout(TIMEOUT_MS),
            ...(cuerpo === undefined ? {} : { body: cuerpo }),
          });

          if (!res.ok) {
            // Un status en el error es lo que `esReintentable` y `mapSnovError` leen.
            throw Object.assign(new Error(`HTTP ${res.status} en ${ruta}`), {
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
      const traducido = mapSnovError(error, { operacion: ruta });
      throw traducido instanceof Error ? traducido : new Error(`Falló ${ruta}`);
    }
  }

  /**
   * El enriquecimiento entero. `success: false` significa "no es prospect nuestro",
   * que **no es un error**: es la respuesta a "¿le escribimos alguna vez?".
   *
   * Ojo con el nombre: es `get-prospects-by-email` y va por POST.
   * `prospect-by-email` da 404 y el mismo path por GET da 403.
   */
  async buscarProspect(email: string): Promise<z.infer<typeof respuestaDeProspectsSchema>> {
    return this.#pedir('get-prospects-by-email', respuestaDeProspectsSchema, {
      metodo: 'POST',
      cuerpo: { email },
    });
  }

  /** `/v1/lists` devuelve 403: la ruta correcta es ésta. */
  async listarListas(): Promise<z.infer<typeof listasDelUsuarioSchema>> {
    return this.#pedir('get-user-lists', listasDelUsuarioSchema, { metodo: 'GET' });
  }

  /**
   * Las listas de do-not-email, que **no** son las de prospects: no aparecen en
   * `get-user-lists` porque viven en Campaigns → Do-not-contact lists.
   *
   * **`GET /v2/blacklists`** — otra versión de la API, no `/v1/`. El GET al mismo
   * path que el POST de escritura devuelve 403, que parece de permisos y en
   * realidad es que esa ruta de lectura no existe (SPEC.md § do-not-email).
   */
  async listarListasDeDoNotEmail(): Promise<z.infer<typeof listasDeDoNotEmailSchema>> {
    return this.#pedir('blacklists', listasDeDoNotEmailSchema, {
      metodo: 'GET',
      version: 'v2',
    });
  }

  /**
   * POST a una ruta de escritura. Lo usa `SnovWriter` y nadie más.
   *
   * Falla en seco si el cliente no se construyó con `escrituraHabilitada`. Que
   * sea un throw y no un no-op es deliberado: un no-op reportaría éxito sobre
   * algo que no pasó, que es la falla silenciosa que este proyecto evita.
   */
  async escribir<T extends z.ZodTypeAny>(
    ruta: string,
    schema: T,
    cuerpo: unknown,
  ): Promise<z.infer<T>> {
    this.#verificarEscritura(ruta);
    return this.#pedir(ruta, schema, { metodo: 'POST', cuerpo });
  }

  /**
   * Igual que `escribir()` pero form-encoded, para las rutas que no aceptan JSON.
   * Hoy solo `do-not-email-list` (SPEC.md § do-not-email).
   */
  async escribirFormulario<T extends z.ZodTypeAny>(
    ruta: string,
    schema: T,
    campos: Record<string, string | readonly string[]>,
  ): Promise<z.infer<T>> {
    this.#verificarEscritura(ruta);
    return this.#pedir(ruta, schema, { metodo: 'POST', formulario: campos });
  }

  /**
   * Arranca la verificación de hasta 10 direcciones. Devuelve un `task_hash` que
   * se consulta después con `resultadoDeVerificacion`.
   *
   * **Detrás de `escrituraHabilitada` aunque no escriba en ninguna lista.** El
   * verificador es un producto pago: consume créditos de la cuenta. Un cliente de
   * solo lectura no debería poder gastar plata.
   */
  async iniciarVerificacion(
    emails: readonly string[],
  ): Promise<z.infer<typeof verificacionIniciadaSchema>> {
    this.#verificarEscritura('email-verification/start');
    return this.#pedir('email-verification/start', verificacionIniciadaSchema, {
      metodo: 'POST',
      version: 'v2',
      formulario: { 'emails[]': emails },
    });
  }

  /** El resultado de una verificación arrancada antes. Solo lectura. */
  async resultadoDeVerificacion(
    taskHash: string,
  ): Promise<z.infer<typeof resultadoDeVerificacionSchema>> {
    return this.#pedir(
      `email-verification/result?task_hash=${encodeURIComponent(taskHash)}`,
      resultadoDeVerificacionSchema,
      { metodo: 'GET', version: 'v2' },
    );
  }

  #verificarEscritura(ruta: string): void {
    if (this.#opciones.escrituraHabilitada !== true) {
      throw new Error(
        `Escritura en Snov deshabilitada: se intentó ${ruta} con un cliente de solo lectura. ` +
          'Se habilita con EXTERNAL_WRITE_ENABLED=true.',
      );
    }
  }
}
