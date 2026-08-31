import type { Category } from '../categories.js';

/**
 * Cómo se pesa un desacuerdo entre el clasificador y la anotación humana.
 *
 * No todos los errores valen lo mismo, y promediarlos en un solo porcentaje
 * esconde justo los que importan (SPEC.md).
 */

/** Pares que la práctica trata como intercambiables: no cuentan como fallo. */
const HERMANAS: ReadonlyArray<readonly [string, string]> = [['NO_THANKS', 'NOT_NOW']];

/**
 * Confusiones baratas: las dos categorías terminan en revisión humana, así que el
 * error no tiene consecuencia automática.
 */
const AMBAS_A_REVISION: ReadonlyArray<readonly [string, string]> = [
  ['HOT', 'TO_MANUAL_SORT'],
  ['HOT', 'OTHER'],
  ['TO_MANUAL_SORT', 'OTHER'],
];

/**
 * Confusiones caras: acciones irreversibles o pérdida de plata.
 *
 *  - Cualquier cosa contra `UNSUBSCRIBE` saca al prospect de todas las campañas.
 *  - `NO_ES_RESPUESTA` se archiva y nadie la vuelve a mirar.
 *  - Bajar un `HOT` o un `TO_MANUAL_SORT` a una negativa manda a un drip
 *    automático una conversación que estaba abierta.
 */
const GRAVES: ReadonlyArray<readonly [string, string]> = [
  ['UNSUBSCRIBE', 'NO_THANKS'],
  ['UNSUBSCRIBE', 'NOT_NOW'],
  ['UNSUBSCRIBE', 'TO_MANUAL_SORT'],
  ['UNSUBSCRIBE', 'HOT'],
  ['NO_ES_RESPUESTA', 'HOT'],
  ['NO_ES_RESPUESTA', 'TO_MANUAL_SORT'],
  ['NO_ES_RESPUESTA', 'NO_THANKS'],
  ['NO_ES_RESPUESTA', 'NOT_NOW'],
  ['HOT', 'NO_THANKS'],
  ['HOT', 'NOT_NOW'],
  ['TO_MANUAL_SORT', 'NO_THANKS'],
  ['TO_MANUAL_SORT', 'NOT_NOW'],
];

export type Severidad = 'acierto' | 'hermanas' | 'leve' | 'grave';

function estaEn(pares: ReadonlyArray<readonly [string, string]>, a: string, b: string): boolean {
  return pares.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

export function severidad(esperada: string, obtenida: string): Severidad {
  if (esperada === obtenida) return 'acierto';
  if (estaEn(HERMANAS, esperada, obtenida)) return 'hermanas';
  if (estaEn(GRAVES, esperada, obtenida)) return 'grave';
  if (estaEn(AMBAS_A_REVISION, esperada, obtenida)) return 'leve';
  return 'grave';
}

export interface Resultado {
  messageId: string;
  from: string;
  esperada: string;
  obtenida: Category;
  confianza: number;
  razon: string;
  severidad: Severidad;
}

export interface Reporte {
  total: number;
  aciertos: number;
  hermanas: number;
  leves: number;
  graves: number;
  /** Aciertos + confusiones entre hermanas, que el SPEC no cuenta como fallo. */
  precision: number;
  porCategoria: Map<string, { total: number; aciertos: number }>;
  /** Los que el umbral habría mandado a revisión humana. */
  bajoUmbral: number;
}

export function armarReporte(resultados: readonly Resultado[], umbral: number): Reporte {
  const porCategoria = new Map<string, { total: number; aciertos: number }>();

  for (const r of resultados) {
    const fila = porCategoria.get(r.esperada) ?? { total: 0, aciertos: 0 };
    fila.total += 1;
    if (r.severidad === 'acierto' || r.severidad === 'hermanas') fila.aciertos += 1;
    porCategoria.set(r.esperada, fila);
  }

  const cuenta = (s: Severidad): number => resultados.filter((r) => r.severidad === s).length;
  const aciertos = cuenta('acierto');
  const hermanas = cuenta('hermanas');

  return {
    total: resultados.length,
    aciertos,
    hermanas,
    leves: cuenta('leve'),
    graves: cuenta('grave'),
    precision: resultados.length === 0 ? 0 : (aciertos + hermanas) / resultados.length,
    porCategoria,
    bajoUmbral: resultados.filter((r) => r.confianza < umbral).length,
  };
}
