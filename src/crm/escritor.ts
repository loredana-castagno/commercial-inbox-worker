import type { CrmClient } from './client.js';
import { altaDeContactoSchema, type AltaDeContacto } from './schemas.js';

/**
 * El alta de contactos en el CRM.
 *
 * Dos trampas del endpoint están cerradas **por tipos**, no por disciplina. Las
 * dos son del tipo que no rompe nada visible cuando se olvida, que es la razón
 * para no dejarlas en un comentario (CLAUDE.md #6).
 */

export interface BarreraDeEscrituraExterna {
  readonly externalWriteEnabled: boolean;
}

/**
 * Lo que se manda en el POST.
 *
 * **`gmailMsgIdDec` es obligatorio y no opcional a propósito.** El CRM arma el
 * marcador de deduplicación así:
 *
 * ```js
 * const rfc822MsgId = emailData?.rfc822MessageId || `msg-${gmailMsgIdDec || Date.now()}`
 * ```
 *
 * Sin el campo, el marcador queda `msg-<timestamp>`, **distinto en cada corrida**.
 * El contacto no se duplica, pero se crea una `Note` nueva cada vez que se
 * reprocesa el mismo rango — y cada `Note` es una llamada al LLM del lado del CRM.
 * Choca de frente con la regla de idempotencia de CLAUDE.md, y no da ningún
 * síntoma: todo devuelve 200. Por eso lo exige el tipo.
 *
 * **`accountEmail` no existe en esta interfaz, y es deliberado.** Para un caller de
 * servicio da 403 siempre: el fetch por IMAP resuelve el buzón con el app password
 * guardado de ese usuario, así que permitirlo convertiría esta key en una de "leer
 * cualquier casilla". Omitirlo además hace que el CRM use nuestro `bodyText` —que
 * ya viene con el citado limpio— en vez de volver a bajar el mail por IMAP.
 */
export interface ContactoDesdeMail {
  readonly email: string;
  readonly fullName?: string | undefined;
  /** Id del mensaje de Gmail en decimal. Ver `aDecimal`. */
  readonly gmailMsgIdDec: string;
  readonly subject?: string | undefined;
  readonly bodyText?: string | undefined;
}

/**
 * Convierte el id de mensaje de Gmail (hexadecimal, `18f6c827742c0dc9`) al decimal
 * que espera el CRM.
 *
 * El nombre del campo dice `Dec` y la extensión de Gmail lo manda así. Mandar el
 * hexadecimal armaría un marcador de dedup distinto del de la extensión para el
 * mismo mail, que es exactamente el problema que el campo viene a evitar.
 */
export function aDecimal(gmailMessageId: string): string {
  if (!/^[0-9a-f]+$/i.test(gmailMessageId)) {
    throw new Error(
      `"${gmailMessageId}" no es un id de mensaje de Gmail: se esperaba hexadecimal.`,
    );
  }
  return BigInt(`0x${gmailMessageId}`).toString(10);
}

/**
 * Qué pasó. `ya-estaba` **no es un error**: el CRM devuelve **409** cuando el
 * contacto existía y nada cambió, y para el worker eso es éxito — el estado final
 * deseado ya se cumple.
 *
 * Es la misma trampa que el 422 de Snov. Tomado literal, el worker marcaría como
 * fallida la operación que mejor salió y mandaría a revisión humana justo los
 * mails de un rango reprocesado.
 */
export type ResultadoDeAlta =
  | { readonly estado: 'creado'; readonly respuesta: AltaDeContacto }
  | { readonly estado: 'ya-estaba'; readonly id?: string | undefined };

function esDuplicado(error: unknown): boolean {
  return Number((error as { status?: unknown } | null)?.status) === 409;
}

function idDelDuplicado(error: unknown): string | undefined {
  const cuerpo = (error as { cuerpo?: unknown } | null)?.cuerpo;
  if (typeof cuerpo !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(cuerpo);
    const id = (parsed as { id?: unknown }).id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
  } catch {
    return undefined;
  }
}

export class CrmWriter {
  readonly #cliente: CrmClient;

  private constructor(cliente: CrmClient) {
    this.#cliente = cliente;
  }

  /** El único constructor. Sin el flag devuelve `undefined`. */
  static crear(cliente: CrmClient, barrera: BarreraDeEscrituraExterna): CrmWriter | undefined {
    return barrera.externalWriteEnabled ? new CrmWriter(cliente) : undefined;
  }

  async crearContacto(contacto: ContactoDesdeMail): Promise<ResultadoDeAlta> {
    try {
      const respuesta = await this.#cliente.escribir(altaDeContactoSchema, {
        ...contacto,
        source: 'Ally Inbox Bot',
      });
      return { estado: 'creado', respuesta };
    } catch (error) {
      if (esDuplicado(error)) return { estado: 'ya-estaba', id: idDelDuplicado(error) };
      throw error;
    }
  }
}
