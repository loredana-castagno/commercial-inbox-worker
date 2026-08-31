import type { GmailClient } from './client.js';

/**
 * Las etiquetas de la casilla de Ally, con la cuota que le toca a cada una en el
 * dataset de evaluación.
 *
 * **No confundir con `etiquetas.ts`**, que es el mapeo de categoría a nombre de
 * etiqueta que usa el worker para escribir. Esto es solo el presupuesto de
 * muestreo de la Fase 2 y no interviene en ninguna escritura.
 *
 * Las cuotas no son proporcionales al volumen: `UNDELIVERABLE` y `EMAIL MODIFIED`
 * están estructuralmente determinados (un bounce de mailer-daemon es un bounce), y
 * ahí el label alcanza como señal. El presupuesto de anotación se gasta donde el
 * clasificador se la puede llevar puesta: los tres drips, `UNSUBSCRIBE` —que ya
 * sabemos que está lleno de newsletters— `REFERRAL` y `HOT`.
 */
export interface EtiquetaDelDataset {
  nombre: string;
  cuota: number;
  nota?: string;
}

export const ETIQUETAS: readonly EtiquetaDelDataset[] = [
  { nombre: 'NO THANKS DRIP', cuota: 18 },
  { nombre: 'NOT NOW DRIP', cuota: 18 },
  { nombre: 'NOT NOW TWO DRIP', cuota: 14 },
  { nombre: 'UNSUBSCRIBE', cuota: 18, nota: '10/10 newsletters en la muestra: el label miente' },
  { nombre: 'REFERRAL', cuota: 14 },
  { nombre: 'HOT', cuota: 14 },
  { nombre: 'COLD (LAST TRY)', cuota: 10, nota: 'declinación amable con conversación abierta' },
  // La etiqueta se renombró dos veces: `TO SORT` → `TO MANUAL SORT` → `REPLIED
  // BEFORE`. Es siempre la misma, con los mails que ya tenía. Este nombre tiene que
  // coincidir con el de la casilla al correr el muestreo, no con el del mapeo.
  { nombre: 'REPLIED BEFORE', cuota: 10, nota: 'interés real sin oportunidad confirmada' },
  { nombre: 'OOO', cuota: 8 },
  { nombre: 'UNDELIVERABLE', cuota: 3, nota: 'estructuralmente determinado' },
  { nombre: 'EMAIL MODIFIED', cuota: 3, nota: 'estructuralmente determinado' },
] as const;

export type MapaDeEtiquetas = Map<string, { id: string; total: number }>;

/**
 * Resuelve nombre → id. Hay que resolver por id y no por `q`: Gmail traduce
 * "COLD (LAST TRY)" a `label:cold--last-try-`, y una consulta mal escrita no da
 * error, da cero resultados — que se lee igual que "la etiqueta está vacía".
 */
export async function resolverEtiquetas(client: GmailClient): Promise<MapaDeEtiquetas> {
  const { labels } = await client.listarEtiquetas();
  const mapa: MapaDeEtiquetas = new Map();

  for (const l of labels ?? []) {
    mapa.set(l.name.toUpperCase(), { id: l.id, total: l.messagesTotal ?? 0 });
  }

  return mapa;
}
