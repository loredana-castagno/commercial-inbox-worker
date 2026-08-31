import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { CATEGORIES } from '../categories.js';
import { ejecutarConRetry } from '../retry.js';
import { mensajeDelMail, SISTEMA } from './prompt.js';

/**
 * El clasificador.
 *
 * Devuelve categoría, entidades y confianza — nada más. Las consecuencias las
 * decide `src/execute/` con el enriquecimiento de Snov (CLAUDE.md, SPEC.md).
 */

export const salidaSchema = z.object({
  categoria: z.enum(CATEGORIES),
  /** Entre 0 y 1. Debajo de CONFIDENCE_THRESHOLD el mail va a revisión humana. */
  confianza: z.number().min(0).max(1),
  /** Una línea que justifique la elección. Es lo que lee quien revisa la cola. */
  razon: z.string(),
  entidades: z.object({
    /** REFERRAL: a quién deriva. */
    referidoNombre: z.string().nullable(),
    referidoEmail: z.string().nullable(),
    /** OOO: cuándo vuelve, tal como lo dice el mail. */
    fechaRetorno: z.string().nullable(),
    /** OOO / UNSUBSCRIBE: si indica que dejó la empresa. */
    dejoLaEmpresa: z.boolean(),
    /** EMAIL_MODIFIED: la dirección nueva. */
    emailNuevo: z.string().nullable(),
    /**
     * El nombre de pila de quien escribe, para el saludo del draft y el
     * `{{first_name}}` de las campañas de Snov.
     *
     * Lo hace el LLM porque el heurístico sobre el header se quedó corto: ve la
     * firma y el cuerpo, no solo el `From`. `null` cuando escribe una casilla de
     * departamento o no hay nombre de persona — ahí el saludo queda en `XXX`,
     * que es lo que hace Ally cuando le falta el dato.
     */
    primerNombre: z.string().nullable(),
  }),
});

export type Salida = z.infer<typeof salidaSchema>;

/**
 * El mismo contrato en JSON Schema, que es lo que entiende `output_config.format`.
 *
 * Escrito a mano y no derivado con `zodOutputFormat`: ese helper requiere Zod 4 y
 * el repo está en Zod 3 (lo usan el config, Gmail, Snov y el dataset). Migrar por
 * una llamada no se justifica.
 *
 * El costo es que hay dos definiciones del mismo contrato. Lo que evita que se
 * desincronicen: el `enum` sale de `CATEGORIES`, y **la respuesta se valida
 * igual con `salidaSchema`** — si divergen, falla el parseo, no se cuela.
 */
const FORMATO_JSON = {
  type: 'json_schema' as const,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['categoria', 'confianza', 'razon', 'entidades'],
    properties: {
      categoria: { type: 'string', enum: [...CATEGORIES] },
      // Sin minimum/maximum: la API los rechaza en tipos number.
      // El rango lo valida `salidaSchema` al parsear, que es donde corresponde.
      confianza: { type: 'number', description: 'Entre 0 y 1' },
      razon: { type: 'string' },
      entidades: {
        type: 'object',
        additionalProperties: false,
        required: [
          'referidoNombre',
          'referidoEmail',
          'fechaRetorno',
          'dejoLaEmpresa',
          'emailNuevo',
          'primerNombre',
        ],
        properties: {
          referidoNombre: { type: ['string', 'null'] },
          referidoEmail: { type: ['string', 'null'] },
          fechaRetorno: { type: ['string', 'null'] },
          dejoLaEmpresa: { type: 'boolean' },
          emailNuevo: { type: ['string', 'null'] },
          primerNombre: { type: ['string', 'null'] },
        },
      },
    },
  },
};

export interface MailAClasificar {
  from: string;
  /**
   * El display name del header `From`. Sirve para `primerNombre`: es de donde
   * sale el nombre casi siempre, y los formatos que ponen el apellido adelante
   * (`VOZENIN Marie-Catherine`) necesitan que el LLM lo vea entero.
   */
  nombreDelRemitente?: string | null;
  subject: string | null;
  cuerpo: string;
}

export interface OpcionesDelClasificador {
  apiKey: string;
  modelo: string;
  /** Inyectable para testear sin red. */
  clienteImpl?: Pick<Anthropic['messages'], 'create'>;
  dormir?: (ms: number) => Promise<void>;
}

export class ErrorDeClasificacion extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ErrorDeClasificacion';
  }
}

export class Clasificador {
  readonly #messages: Pick<Anthropic['messages'], 'create'>;
  readonly #modelo: string;
  readonly #dormir: ((ms: number) => Promise<void>) | undefined;

  constructor(opciones: OpcionesDelClasificador) {
    this.#messages = opciones.clienteImpl ?? new Anthropic({ apiKey: opciones.apiKey }).messages;
    this.#modelo = opciones.modelo;
    this.#dormir = opciones.dormir;
  }

  async clasificar(mail: MailAClasificar): Promise<Salida> {
    const respuesta = await ejecutarConRetry(
      () =>
        this.#messages.create({
          model: this.#modelo,
          // El razonamiento consume tokens de salida: con un tope chico se corta
          // a la mitad y la respuesta queda inválida.
          max_tokens: 2048,
          // La taxonomía es idéntica en cada llamada: se cachea y el prefijo
          // pasa a costar una décima parte.
          system: [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }],
          // Clasificar no necesita pensar mucho, y el esfuerzo se paga en tokens.
          output_config: { effort: 'low', format: FORMATO_JSON },
          messages: [{ role: 'user', content: mensajeDelMail(mail) }],
        }),
      this.#dormir === undefined ? {} : { dormir: this.#dormir },
    );

    if (respuesta.stop_reason === 'refusal') {
      throw new ErrorDeClasificacion(
        `El modelo se negó a clasificar el mail de ${mail.from}. ` +
          'Va a revisión humana: no se puede inferir una categoría de una negativa.',
      );
    }

    const texto = respuesta.content.find((b) => b.type === 'text');
    if (texto === undefined || texto.type !== 'text') {
      throw new ErrorDeClasificacion(
        `La respuesta no trajo texto (stop_reason: ${respuesta.stop_reason}). ` +
          'Suele ser truncamiento por max_tokens.',
      );
    }

    // Se valida con Zod aunque el modelo haya respetado el JSON Schema: es la
    // convención del repo para todo lo que llega de una API externa.
    return salidaSchema.parse(JSON.parse(texto.text));
  }
}
