import type { CrmClient } from '../crm/client.js';
import type { SnovClient } from '../snov/client.js';
import { enriquecerProspect } from '../snov/enriquecer.js';
import type { GmailClient } from './client.js';
import { parsearMensaje, type MensajeParseado } from './parse.js';

/**
 * Buscar en Spam las respuestas reales de prospects.
 *
 * ## Por qué esto funciona y las tres reglas anteriores no
 *
 * SPEC.md § Spam documenta tres reglas determinísticas que se probaron y fallaron:
 * que el hilo tenga un mail nuestro, que el `In-Reply-To` apunte a algo que
 * enviamos, y que el cuerpo mencione MyCompany. **Las tres miran adentro de Gmail**, y
 * ahí está el problema: las campañas salen desde Snov, así que el envío original no
 * existe en la casilla. La tercera además da falsos positivos con el phishing, que
 * menciona MyCompany *porque* se hace pasar por MyCompany.
 *
 * La señal que sirve **vive afuera**: ¿este remitente está en Snov o en el CRM? Un
 * phishing no está; un prospect al que le escribimos, sí.
 *
 * ## Qué NO decide este módulo
 *
 * Solo identifica candidatos y los devuelve. No saca nada de Spam ni etiqueta: eso
 * lo hace quien tiene el writer, detrás de `GMAIL_WRITE_ENABLED`.
 */

export interface Rescatable {
  readonly mensaje: MensajeParseado;
  readonly enSnov: boolean;
  /** `null` cuando no se pudo consultar el CRM. */
  readonly enCrm: boolean | null;
}

export interface ResumenDeSpam {
  readonly revisados: number;
  readonly propios: number;
  readonly rescatables: Rescatable[];
  readonly desconocidos: number;
}

/** De dónde salió la señal, para el log y para quien revisa. */
export function origenDe(r: Rescatable): string {
  return [r.enSnov ? 'Snov' : null, r.enCrm === true ? 'CRM' : null]
    .filter((x) => x !== null)
    .join(' + ');
}

export async function buscarRescatablesEnSpam(opciones: {
  readonly gmail: GmailClient;
  readonly snov: SnovClient;
  readonly crm?: CrmClient | undefined;
  readonly dominiosPropios: readonly string[];
  readonly tope: number;
  readonly onError?: ((mensaje: string) => void) | undefined;
}): Promise<ResumenDeSpam> {
  const { gmail, snov, crm, dominiosPropios, tope } = opciones;
  const avisar = opciones.onError ?? ((m: string) => console.error(m));

  // `labelIds: ['SPAM']` alcanza: pedir la etiqueta ya implica incluirla, sin
  // necesidad de `includeSpamTrash`.
  const lista = await gmail.listarMensajes({ labelIds: ['SPAM'], maxResults: tope });
  const ids = (lista.messages ?? []).map((m) => m.id);

  const rescatables: Rescatable[] = [];
  let propios = 0;
  let desconocidos = 0;

  for (const id of ids) {
    const mensaje = parsearMensaje(await gmail.obtenerMensaje(id));

    const dominio = mensaje.from.email.split('@').at(-1)?.toLowerCase() ?? '';
    if (dominiosPropios.some((d) => d.toLowerCase() === dominio)) {
      propios += 1;
      continue;
    }

    let enSnov = false;
    try {
      enSnov = (await enriquecerProspect(snov, mensaje.from.email)).esProspect;
    } catch (e) {
      avisar(`  Snov falló para ${mensaje.from.email}: ${(e as Error).message.slice(0, 70)}`);
    }

    let enCrm: boolean | null = null;
    if (crm !== undefined) {
      try {
        enCrm = (await crm.buscarPorEmail(mensaje.from.email)).exists;
      } catch (e) {
        avisar(`  CRM falló para ${mensaje.from.email}: ${(e as Error).message.slice(0, 70)}`);
      }
    }

    if (enSnov || enCrm === true) rescatables.push({ mensaje, enSnov, enCrm });
    else desconocidos += 1;
  }

  return { revisados: ids.length, propios, rescatables, desconocidos };
}

/**
 * ¿Toca barrer Spam?
 *
 * El inbox se mira cada `POLL_INTERVAL_MINUTES`; Spam un par de veces al día. Son
 * ritmos distintos porque el costo también lo es: cada mensaje de Spam cuesta una
 * consulta a Snov y otra al CRM, y ahí no hay cursor incremental que ayude — se
 * revisa la carpeta entera cada vez.
 */
export function tocaBarrerSpam(
  ultimo: Date | null,
  cadaHoras: number,
  ahora: Date = new Date(),
): boolean {
  if (ultimo === null) return true;
  return ahora.getTime() - ultimo.getTime() >= cadaHoras * 60 * 60 * 1000;
}
