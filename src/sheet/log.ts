import type { ResultadoDeEjecucion } from '../execute/executor.js';
import { SheetClient } from './cliente.js';

/**
 * El log del worker en un Sheet del Drive de Ally.
 *
 * Es lo que pidió Ally: ver, mientras el bot corre, qué hizo con cada mail para
 * poder corregir errores desde afuera. En shadow mode dice qué *habría* hecho, que
 * es justamente cuando más sirve mirarlo — por eso tiene su propio flag y **no**
 * cuelga de `EXTERNAL_WRITE_ENABLED`: si colgara de ahí, el log solo existiría
 * cuando ya es tarde para revisar.
 *
 * Dos reglas de diseño, las dos por el mismo motivo (esto es observabilidad, no
 * el trabajo):
 *
 * 1. **Nunca tira una excepción hacia afuera.** Si Sheets está caído, el mail se
 *    procesa igual y el error va a la consola. Un log que puede frenar el worker
 *    es un modo de falla nuevo, no una herramienta.
 * 2. **Es append-only.** El cliente no expone borrar ni editar: una corrida no
 *    puede pisar lo que escribió la anterior.
 */

export const PESTAÑA_ACTIVIDAD = 'Actividad';
export const PESTAÑA_CORRIDAS = 'Corridas';

const ENCABEZADO_ACTIVIDAD = [
  'Procesado (GMT -3)',
  'Fecha del mail (GMT -3)',
  'De',
  'Nombre',
  'Asunto',
  'Extracto',
  'Categoría',
  'Categoría base',
  'Confianza',
  'Clasificó',
  'Qué hizo el bot',
  'Por qué no lo hizo',
  '¿Revisión humana?',
  'Motivo de revisión',
  'Modo',
  'Abrir en Gmail',
] as const;

const ENCABEZADO_CORRIDAS = [
  'Cuándo (GMT -3)',
  'Vía',
  'Mensajes vistos',
  'Calentamiento omitido',
  'Salientes ignorados',
  'Ya procesados',
  'Clasificados',
  'A revisión humana',
  'Acciones ejecutadas',
  'Modo',
] as const;

export interface MailRegistrado {
  readonly messageId: string;
  readonly fecha: Date;
  readonly from: string;
  readonly nombre: string | null;
  readonly asunto: string | null;
  readonly cuerpo: string;
  readonly confianza: number;
  /** Modelo del clasificador, o la etiqueta del prefiltro que lo resolvió. */
  readonly clasificoPor: string;
  readonly resultado: ResultadoDeEjecucion;
  readonly motivosDeRevision: readonly string[];
}

export interface CorridaRegistrada {
  readonly via: string;
  readonly vistos: number;
  readonly calentamiento: number;
  readonly salientes: number;
  readonly yaProcesados: number;
  readonly clasificados: number;
  readonly aRevision: number;
  readonly ejecutadas: number;
}

export interface ModoDeEscritura {
  readonly gmailWriteEnabled: boolean;
  readonly externalWriteEnabled: boolean;
}

/**
 * `YYYY-MM-DD HH:mm (GMT -3)`, sin segundos. Es el huso de Ally, no el del
 * servidor —el EC2 corre en UTC—, así que sin esto cada hora del Sheet quedaba
 * tres horas adelantada de lo que se ve en Gmail al mirarlo al lado.
 *
 * Aritmética simple y no `Intl`/timezone de sistema a propósito: Argentina no
 * tiene horario de verano desde 2009, así que el offset es fijo y esto no
 * depende de que el runtime tenga la base de zonas horarias completa.
 */
export function formatearGmtMenos3(fecha: Date): string {
  const conOffset = new Date(fecha.getTime() - 3 * 60 * 60 * 1000);
  const yyyy = conOffset.getUTCFullYear();
  const mm = String(conOffset.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(conOffset.getUTCDate()).padStart(2, '0');
  const hh = String(conOffset.getUTCHours()).padStart(2, '0');
  const min = String(conOffset.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min} (GMT -3)`;
}

/** Una línea de texto: el Sheet no muestra saltos y los tabs rompen las columnas. */
function unaLinea(texto: string, maximo: number): string {
  const plano = texto.replace(/\s+/g, ' ').trim();
  return plano.length <= maximo ? plano : `${plano.slice(0, maximo - 1)}…`;
}

function describirModo(modo: ModoDeEscritura): string {
  if (modo.externalWriteEnabled) return 'escritura completa';
  if (modo.gmailWriteEnabled) return 'solo Gmail';
  return 'shadow (no escribe)';
}

export function filaDeMail(mail: MailRegistrado, modo: ModoDeEscritura, ahora: Date): string[] {
  // Lo que efectivamente pasó, separado de lo que quedó pendiente. Son dos
  // columnas y no una porque son dos preguntas distintas: "¿qué hizo?" y "¿por
  // qué no hizo el resto?". Mezcladas no se pueden filtrar.
  const hechas = mail.resultado.resultados
    .filter((r) => r.estado === 'ejecutada')
    .map((r) => r.descripcion);

  // Las fallidas van en la misma columna que las omitidas, con marca propia: son
  // el caso que hay que mirar primero, y filtrar por "FALLÓ" tiene que alcanzar.
  // Si quedaran fuera de las dos columnas desaparecerían del log sin dejar rastro.
  const omitidas = mail.resultado.resultados
    .filter((r) => r.estado === 'planeada' || r.estado === 'fallida')
    .map((r) =>
      r.estado === 'fallida'
        ? `FALLÓ: ${r.descripcion} → ${r.motivo}`
        : `${r.descripcion} → ${r.motivo}`,
    );

  return [
    formatearGmtMenos3(ahora),
    formatearGmtMenos3(mail.fecha),
    mail.from,
    mail.nombre ?? '',
    unaLinea(mail.asunto ?? '', 200),
    unaLinea(mail.cuerpo, 500),
    mail.resultado.categoriaFinal,
    mail.resultado.categoriaBase ?? '',
    mail.confianza.toFixed(2),
    mail.clasificoPor,
    hechas.join(' · ') || '—',
    omitidas.join(' · ') || '—',
    mail.resultado.necesitaRevision ? 'SÍ' : 'no',
    mail.motivosDeRevision.join(' | '),
    describirModo(modo),
    `https://mail.google.com/mail/u/0/#all/${mail.messageId}`,
  ];
}

export function filaDeCorrida(
  c: CorridaRegistrada,
  modo: ModoDeEscritura,
  ahora: Date,
): string[] {
  return [
    formatearGmtMenos3(ahora),
    c.via,
    String(c.vistos),
    String(c.calentamiento),
    String(c.salientes),
    String(c.yaProcesados),
    String(c.clasificados),
    String(c.aRevision),
    String(c.ejecutadas),
    describirModo(modo),
  ];
}

export class SheetLogger {
  readonly #cliente: SheetClient;
  readonly #modo: ModoDeEscritura;
  readonly #ahora: () => Date;
  #preparado = false;

  constructor(cliente: SheetClient, modo: ModoDeEscritura, ahora: () => Date = () => new Date()) {
    this.#cliente = cliente;
    this.#modo = modo;
    this.#ahora = ahora;
  }

  /**
   * Todo lo que toca la red pasa por acá. Un fallo del log se reporta y se
   * descarta: el worker sigue. Es la regla 1 del módulo.
   */
  async #seguro(que: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.error(`  [sheet] no se pudo ${que}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  /**
   * Crea las pestañas y los encabezados si faltan. Idempotente: se puede llamar
   * en cada corrida, y en un Sheet ya inicializado no escribe nada.
   */
  async preparar(): Promise<void> {
    if (this.#preparado) return;

    await this.#seguro('preparar el Sheet', async () => {
      const existentes = await this.#cliente.pestañas();

      for (const [pestaña, encabezado] of [
        [PESTAÑA_ACTIVIDAD, ENCABEZADO_ACTIVIDAD],
        [PESTAÑA_CORRIDAS, ENCABEZADO_CORRIDAS],
      ] as const) {
        if (!existentes.includes(pestaña)) await this.#cliente.crearPestaña(pestaña);

        // El encabezado se escribe solo si la pestaña está vacía. Si ya tiene
        // filas, agregarlo otra vez metería un encabezado en el medio de los datos.
        if ((await this.#cliente.filasOcupadas(pestaña)) === 0) {
          await this.#cliente.agregarFilas(pestaña, [[...encabezado]]);
          await this.#cliente.formatearEncabezado(pestaña);
        }
      }

      this.#preparado = true;
    });
  }

  async registrarMail(mail: MailRegistrado): Promise<void> {
    await this.#seguro(`registrar ${mail.from}`, () =>
      this.#cliente.agregarFilas(PESTAÑA_ACTIVIDAD, [
        filaDeMail(mail, this.#modo, this.#ahora()),
      ]),
    );
  }

  async registrarCorrida(corrida: CorridaRegistrada): Promise<void> {
    await this.#seguro('registrar la corrida', () =>
      this.#cliente.agregarFilas(PESTAÑA_CORRIDAS, [
        filaDeCorrida(corrida, this.#modo, this.#ahora()),
      ]),
    );
  }
}
