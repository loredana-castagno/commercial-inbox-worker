import { z } from 'zod';
import type { SnovClient } from './client.js';

/**
 * Las escrituras de Snov: agregar a una lista y agregar a do-not-email.
 *
 * **Vive aparte de `SnovClient` a propósito.** El cliente sigue siendo de solo
 * lectura y no expone ningún método que escriba: no hay forma de subir a alguien
 * a una lista teniendo solo un `SnovClient` en la mano.
 *
 * Y esta clase **no se puede construir sin la barrera**: el constructor es
 * privado y el único camino es `SnovWriter.crear(...)`, que devuelve `undefined`
 * cuando `EXTERNAL_WRITE_ENABLED` está apagado. Es la forma preferida de
 * CLAUDE.md #6 — hacer imposible el bypass por tipos, no por convención.
 *
 * ```ts
 * new SnovWriter(cliente)                    // no compila: constructor privado
 * SnovWriter.crear(cliente, { externalWriteEnabled: false })  // undefined
 * ```
 *
 * Las dos operaciones no pesan igual, y está anotado en cada método.
 */

/**
 * Snov devuelve `success` y a veces un mensaje; el resto varía.
 *
 * **`added` importa y no es decorativo.** En `add-prospect-to-list`, un 200 no
 * significa "quedó en la lista que pediste": si el prospect ya existía, Snov le
 * actualiza los datos, lo deja en su lista original y responde
 * `{"success":true,"added":false,"updated":true}` (SPEC.md § mover entre listas).
 */
export const respuestaDeEscrituraSchema = z
  .object({
    success: z.boolean().optional(),
    message: z.string().optional(),
    added: z.boolean().optional(),
    updated: z.boolean().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

export type RespuestaDeEscritura = z.infer<typeof respuestaDeEscrituraSchema>;

/**
 * Qué pasó realmente. `ya-estaba` **no es un error**: el estado final deseado ya
 * se cumple, y para el worker eso es éxito.
 *
 * Existe porque Snov devuelve **HTTP 422** al reagregar un prospect que ya está
 * en la lista:
 *
 * ```
 * 422 {"success":false,"added":false,"errors":"Prospect with same email already exists in your list"}
 * ```
 *
 * Es la misma trampa que el 409 del CRM (SPEC.md § Escritura). Tomado literal, el
 * worker marcaría como fallida la operación que mejor salió, mandaría el mail a
 * revisión humana y llenaría el Sheet de "FALLÓ" — justo sobre los mails que
 * reprocesa, que por la regla de idempotencia de CLAUDE.md son todos los de un
 * rango repetido.
 */
export type ResultadoDeAlta =
  | { readonly estado: 'agregado'; readonly respuesta: RespuestaDeEscritura }
  | { readonly estado: 'ya-estaba' };

/**
 * Solo el duplicado se perdona. Un 422 por email inválido o listId inexistente
 * tiene que seguir fallando fuerte: tragarse *cualquier* 422 convertiría un error
 * de datos en un éxito silencioso.
 */
function esDuplicado(error: unknown): boolean {
  const e = error as { status?: unknown; cuerpo?: unknown } | null;
  if (Number(e?.status) !== 422) return false;
  return /already exists/i.test(String(e?.cuerpo ?? ''));
}

export interface BarreraDeEscrituraExterna {
  readonly externalWriteEnabled: boolean;
}

/** Datos opcionales del prospect. Snov los usa para los merge tags de la campaña. */
export interface DatosDeProspect {
  readonly fullName?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly companyName?: string;
  readonly position?: string;
}

export class SnovWriter {
  readonly #cliente: SnovClient;

  private constructor(cliente: SnovClient) {
    this.#cliente = cliente;
  }

  /**
   * El único constructor. Sin el flag prendido devuelve `undefined`, y sin un
   * `SnovWriter` no hay forma de llamar a las escrituras.
   */
  static crear(cliente: SnovClient, barrera: BarreraDeEscrituraExterna): SnovWriter | undefined {
    return barrera.externalWriteEnabled ? new SnovWriter(cliente) : undefined;
  }

  /**
   * Agrega un prospect a una lista.
   *
   * **Esto manda correos.** Las listas de Ally tienen una campaña enganchada que
   * levanta sola lo que aparezca ahí (SPEC.md § Listas y campañas). No es "guardar
   * en una carpeta": es poner a alguien en una secuencia de envío.
   *
   * **`createDuplicates: true` no es opcional acá.** Sin ese flag, un prospect que
   * ya existe en otra lista —o sea todos los que responden, porque llegaron por
   * una campaña— no se agrega: Snov le actualiza los datos, lo deja donde estaba
   * y responde `added: false`. Medido contra la API real (SPEC.md § listas).
   *
   * Que quede un perfil por lista es correcto para este caso y no un mal menor:
   * **un lead que responde sale solo de la campaña en la que estaba**, así que el
   * perfil viejo no vuelve a recibir nada y el nuevo entra al drip que
   * corresponde. Por eso alcanza con agregar y no hace falta mover — que es
   * bueno, porque la API de Snov no puede mover (confirmado por su soporte).
   */
  async agregarALista(
    email: string,
    listaId: string,
    datos: DatosDeProspect = {},
  ): Promise<ResultadoDeAlta> {
    try {
      const respuesta = await this.#cliente.escribir(
        'add-prospect-to-list',
        respuestaDeEscrituraSchema,
        { email, listId: listaId, createDuplicates: 'true', ...datos },
      );

      // **Un 200 no alcanza para decir que quedó en la lista**, y por eso se mira
      // `added`. Con `createDuplicates` esto tendría que ser siempre `true`; si
      // aparece un `false`, algo cambió del lado de Snov y hay que mirarlo — no
      // dejarlo pasar como éxito, que es lo que hacía que las altas no llegaran
      // sin que se notara (SPEC.md § listas).
      //
      // Se compara contra `false` explícito: si Snov deja de mandar el campo, el
      // comportamiento vuelve a ser el de antes en vez de romper todo.
      if (respuesta.added === false) {
        throw new Error(
          `Snov no agregó ${email} a la lista ${listaId}: respondió added:false ` +
            'pese a createDuplicates. Revisar contra la API antes de asumir que las ' +
            'altas siguen funcionando (SPEC.md § listas).',
        );
      }

      return { estado: 'agregado', respuesta };
    } catch (error) {
      if (esDuplicado(error)) return { estado: 'ya-estaba' };
      throw error;
    }
  }

  /**
   * Agrega una dirección a una lista de do-not-email.
   *
   * **La operación más cara del sistema y no se deshace desde acá.** Saca al
   * prospect de todas las campañas activas. Una dirección nuestra acá mata en
   * silencio la campaña que sale desde ese alias — por eso los handlers bloquean
   * los dominios propios antes de que la acción llegue a existir.
   *
   * **`listaId` es obligatorio y no opcional a propósito.** La cuenta tiene
   * **seis** listas de do-not-contact, dos de ellas grandes (`Do-not-email (full
   * list)` con 94.322 entradas y otra de HR MyCompany con 87.767). Una baja en la
   * lista equivocada **no protege de nada**: la persona sigue recibiendo la
   * campaña, y no hay ningún síntoma —la API responde 200 igual—. Es la misma
   * clase de trampa que `gmailMsgIdDec` en el CRM, y se cierra igual: exigiéndolo
   * el tipo en vez de dejarlo a la disciplina de quien llame.
   */
  async agregarADoNotEmail(email: string, listaId: string): Promise<ResultadoDeAlta> {
    try {
      // **`items[]` + `listId`, form-encoded.** Sale del ejemplo en Python y de la
      // tabla de parámetros de la doc guardada en `reference/snov-api.html`,
      // después de que la doc web fallara con el path (dos veces) y con el nombre
      // del campo (SPEC.md § do-not-email):
      //
      //   params = {'access_token': token, 'items[]': ['a@b.com', 'b.com']}
      //   requests.post('.../v1/do-not-email-list', data=params)
      //
      // `data=` en `requests` es form-encoded, no JSON: mandarle JSON devuelve
      // `400 "Emails list is empty"` porque el servidor parsea el cuerpo como
      // formulario y no encuentra nada.
      //
      // El ejemplo omite `listId`, pero la tabla de parámetros lo marca
      // **Requerido** — y con siete listas en la cuenta, dejarlo afuera sería
      // pedirle a Snov que elija. Se manda siempre.
      //
      // El endpoint acepta direcciones **y dominios** en el mismo campo; acá
      // siempre se manda una dirección.
      const respuesta = await this.#cliente.escribirFormulario(
        'do-not-email-list',
        respuestaDeEscrituraSchema,
        { 'items[]': [email], listId: listaId },
      );
      return { estado: 'agregado', respuesta };
    } catch (error) {
      // Mismo criterio que la lista. Sin probar contra la API real todavía: si
      // esta ruta señala el duplicado de otra forma, se ajusta acá.
      if (esDuplicado(error)) return { estado: 'ya-estaba' };
      throw error;
    }
  }
}
