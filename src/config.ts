import 'dotenv/config';
import { z } from 'zod';
import { CATEGORIES, NEVER_AUTOMATED, type Category } from './categories.js';

/** Una var seteada como cadena vacía cuenta como ausente. */
const required = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1),
);

const optional = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional(),
);

const boolFlag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const csvCategories = z
  .preprocess(
    (v) => (typeof v === 'string' ? v : ''),
    z.string(),
  )
  .transform((raw) =>
    raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0),
  )
  .superRefine((values, ctx) => {
    for (const value of values) {
      if (!(CATEGORIES as readonly string[]).includes(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${value}" no es una categoría de SPEC.md`,
        });
      }
      if ((NEVER_AUTOMATED as readonly string[]).includes(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${value}" nunca puede automatizarse: siempre va a revisión humana`,
        });
      }
    }
  })
  .transform((values) => values as Category[]);

/**
 * Credenciales de OAuth y nada más. Es lo único que puede exigir el script de
 * `auth:gmail`, que justamente corre para *obtener* el refresh token: si pidiera
 * el env completo nunca podría bootear.
 */
const bootstrapSchema = z.object({
  GOOGLE_CLIENT_ID: required,
  GOOGLE_CLIENT_SECRET: required,
  GOOGLE_REDIRECT_URI: z.string().url(),
  // Van acá y no en el env completo porque el consentimiento se pide *para* un
  // scope y *sobre* una casilla: son justo los datos que `auth:gmail` necesita, y
  // ninguno depende del token. La casilla además se usa como `login_hint`, para
  // que Google preseleccione la cuenta correcta en el selector.
  GMAIL_SCOPE: required,
  GMAIL_USER_EMAIL: z.string().email(),
});

/** Todo lo que necesita el worker. Extiende el bootstrap, no lo duplica. */
const envSchema = bootstrapSchema.extend({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Seguridad. Ambos flags arrancan apagados: sin tocarlos, el worker clasifica y
  // guarda, y no escribe nada afuera. Se habilitan por separado y en este orden.
  GMAIL_WRITE_ENABLED: boolFlag.default('false'),
  EXTERNAL_WRITE_ENABLED: boolFlag.default('false'),
  AUTO_CATEGORIES: csvCategories,

  // Base propia
  DATABASE_URL: required,

  // Gmail (GMAIL_USER_EMAIL y GMAIL_SCOPE vienen del bootstrap)
  GMAIL_REFRESH_TOKEN: required,

  // Clasificador (Anthropic)
  ANTHROPIC_API_KEY: required,
  ANTHROPIC_MODEL: required,
  CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),

  // Snov
  SNOV_CLIENT_ID: required,
  SNOV_CLIENT_SECRET: required,
  SNOV_API_BASE: z.string().url(),
  SNOV_LIST_NO_THANKS: required,
  SNOV_LIST_NOT_NOW: required,
  // No hay SNOV_LIST_NOT_NOW_2: las listas de segunda ronda quedaron en desuso.
  // Una segunda respuesta ahora va a TO_MANUAL_SORT (SPEC.md § Segundas respuestas).
  SNOV_LIST_REFERRALS: required,
  // El id de `Do-not-email (full list)`, la lista que usan las campañas de Ally
  // (94.322 entradas). **La cuenta tiene siete listas de do-not-contact**, dos de
  // ellas grandes, así que mandar el id no es opcional: una baja en la lista
  // equivocada devuelve 200 y no protege de nada (SPEC.md § do-not-email).
  //
  // Con default para que no dependa de que el `.env` lo tenga: es un dato
  // verificado contra la cuenta, no una preferencia de despliegue. Se puede
  // overridear si algún día cambia la lista.
  SNOV_DO_NOT_EMAIL_LIST: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(1).default('1000001'),
  ),

  // CRM: solo HTTP.
  // Ojo con CRM_BASE_URL en desarrollo: 127.0.0.1:3000 es la URL correcta en el
  // EC2, pero en la máquina de desarrollo hay un CRM local escuchando en el mismo
  // puerto sobre dev.db. La URL no distingue los dos casos — el que los distingue
  // es NODE_ENV, y por eso la validación cruzada de abajo lo mira.
  // El token es opcional a propósito: sin él el worker corre en shadow mode, que
  // es todo lo que necesita hasta la Fase 4. La validación cruzada de abajo lo
  // vuelve obligatorio en cuanto se habilita la escritura externa, así que la
  // garantía no se pierde — solo deja de bloquear lo que no depende de él.
  CRM_BASE_URL: z.string().url(),
  CRM_SERVICE_TOKEN: optional,

  // Log en el Sheet del Drive de Ally.
  // Flag propio, deliberadamente **no** atado a EXTERNAL_WRITE_ENABLED: el log
  // tiene que funcionar en shadow mode, que es cuando sirve mirarlo. Escribe en
  // una planilla nuestra, no en la casilla ni en Snov: no comparte el riesgo que
  // gobiernan los otros dos flags.
  SHEET_LOG_ENABLED: boolFlag.default('false'),
  SHEET_LOG_ID: optional,
  GOOGLE_SERVICE_ACCOUNT_FILE: optional,

  /**
   * Cada cuántas horas se revisa Spam. Es otro ritmo que el del inbox a propósito:
   * ahí no hay cursor incremental —se revisa la carpeta entera— y cada mensaje
   * cuesta una consulta a Snov y otra al CRM.
   */
  SPAM_SWEEP_HOURS: z.coerce.number().positive().default(12),

  /**
   * Reproceso por etiqueta: el worker mira los correos con la etiqueta `REPROCESS`
   * y ejecuta lo que dicen las etiquetas que les puso una persona.
   *
   * Apagado por default, como todo lo que actúa afuera. Va como flag propio y no
   * atado a `GMAIL_WRITE_ENABLED` porque es un camino de entrada distinto —no
   * depende del cursor y no lo dispara el correo nuevo— y conviene poder apagarlo
   * sin frenar el triage.
   */
  REPROCESS_ENABLED: boolFlag.default('false'),
  /**
   * Tope de reprocesos por corrida, con presupuesto propio y no el de
   * `MAX_MESSAGES_PER_RUN`: son dos colas distintas y la del reproceso es de
   * volumen manual, así que no tiene por qué competir con el inbox.
   */
  REPROCESS_MAX_PER_RUN: z.coerce.number().int().positive().default(20),

  // Worker
  POLL_INTERVAL_MINUTES: z.coerce.number().int().positive().default(10),
  MAX_MESSAGES_PER_RUN: z.coerce.number().int().positive().default(50),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

/** Scopes de Gmail que permiten modificar labels. `readonly` no alcanza. */
function scopePermiteEscritura(scope: string): boolean {
  return ['gmail.modify', 'https://mail.google.com/'].some((s) => scope.includes(s));
}

/**
 * Validaciones cruzadas: combinaciones que son válidas var por var pero que
 * revientan a mitad de un batch, dejando la mitad de los mails procesados.
 * Preferimos que no arranque.
 */
const validatedEnvSchema = envSchema.superRefine((env, ctx) => {
  if (env.GMAIL_WRITE_ENABLED && !scopePermiteEscritura(env.GMAIL_SCOPE)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['GMAIL_WRITE_ENABLED'],
      message:
        `escritura en Gmail habilitada pero GMAIL_SCOPE es "${env.GMAIL_SCOPE}", que es de solo lectura. ` +
        'Pasar el scope a gmail.modify y rehacer el consentimiento OAuth.',
    });
  }

  if (env.EXTERNAL_WRITE_ENABLED && env.CRM_SERVICE_TOKEN === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CRM_SERVICE_TOKEN'],
      message:
        'escritura externa habilitada sin token del CRM. Con esto el worker crearía ' +
        'leads que fallan de a uno, a mitad de un batch, en vez de no arrancar.',
    });
  }

  if (env.SHEET_LOG_ENABLED) {
    const faltan = (
      [
        ['SHEET_LOG_ID', env.SHEET_LOG_ID],
        ['GOOGLE_SERVICE_ACCOUNT_FILE', env.GOOGLE_SERVICE_ACCOUNT_FILE],
      ] as const
    ).filter(([, valor]) => valor === undefined);

    for (const [nombre] of faltan) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [nombre],
        message:
          `log en Sheets habilitado sin ${nombre}. Un log que no se sabe dónde escribe ` +
          'no avisa cuando no escribe: el worker correría creyendo que queda registro.',
      });
    }
  }

  if (env.EXTERNAL_WRITE_ENABLED && env.NODE_ENV !== 'production') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EXTERNAL_WRITE_ENABLED'],
      message:
        'escritura externa habilitada con NODE_ENV=' +
        `${env.NODE_ENV}. Las escrituras a Snov y al CRM salen solo desde el deploy ` +
        'de producción. En la máquina de desarrollo, CRM_BASE_URL=127.0.0.1:3000 apunta ' +
        'al CRM local sobre dev.db: el worker escribiría, la API devolvería 200 y el log ' +
        'diría que salió bien, contra la base equivocada. PM2 setea NODE_ENV=production ' +
        'en el EC2; para probar una escritura puntual están los scripts de verificación.',
    });
  }

  if (env.REPROCESS_ENABLED && !scopePermiteEscritura(env.GMAIL_SCOPE)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REPROCESS_ENABLED'],
      message:
        `reproceso habilitado pero GMAIL_SCOPE es "${env.GMAIL_SCOPE}", que es de solo lectura. ` +
        'Sin poder quitar la etiqueta REPROCESS el barrido no puede cerrar el ciclo: el ' +
        'mismo correo se reprocesaría en cada corrida. Preferimos que no arranque.',
    });
  }

  if (env.EXTERNAL_WRITE_ENABLED && !env.GMAIL_WRITE_ENABLED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EXTERNAL_WRITE_ENABLED'],
      message:
        'escritura en Snov/CRM habilitada con GMAIL_WRITE_ENABLED=false. ' +
        'No tiene sentido subir una dirección a do-not-email sin poder etiquetar el mail que lo originó.',
    });
  }
});

/** Bootstrap + lo mínimo para leer la casilla. Sin Snov, CRM ni Anthropic. */
const gmailSchema = bootstrapSchema.extend({
  GMAIL_REFRESH_TOKEN: required,
});

/**
 * Lo que necesita hablar con Snov y nada más. Consultar un prospect no tiene por
 * qué exigir el refresh token de Gmail ni la key de Anthropic — mismo criterio
 * que `loadBootstrapEnv` y `loadGmailEnv`.
 */
const snovSchema = z.object({
  SNOV_CLIENT_ID: required,
  SNOV_CLIENT_SECRET: required,
  SNOV_API_BASE: z.string().url(),
  SNOV_LIST_NO_THANKS: required,
  SNOV_LIST_NOT_NOW: required,
  SNOV_LIST_REFERRALS: required,
  // Sin default acá, al revés que en el schema del worker: una herramienta de
  // diagnóstico tiene que poder mostrar que la variable falta, no rellenarla.
  SNOV_DO_NOT_EMAIL_LIST: optional,
});

/** Lo que necesita correr los evals: el clasificador y nada más. */
const evalsSchema = z.object({
  ANTHROPIC_API_KEY: required,
  ANTHROPIC_MODEL: required,
  CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
});

export type Config = z.infer<typeof validatedEnvSchema>;
export type EvalsEnv = z.infer<typeof evalsSchema>;
export type SnovEnv = z.infer<typeof snovSchema>;
export type BootstrapEnv = z.infer<typeof bootstrapSchema>;
export type GmailEnv = z.infer<typeof gmailSchema>;

function parseEnv<T extends z.ZodTypeAny>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(source);

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuración inválida. Revisar .env contra .env.example:\n${detail}`);
  }

  return result.data;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  return parseEnv(validatedEnvSchema, source);
}

export function loadBootstrapEnv(source: NodeJS.ProcessEnv = process.env): BootstrapEnv {
  return parseEnv(bootstrapSchema, source);
}

/**
 * Lo que necesita leer Gmail y nada más. Lo usan las herramientas de solo lectura
 * (`gmail:peek`), que no tienen por qué exigir el token de Snov ni la key de
 * Anthropic para imprimir un mail en pantalla.
 *
 * Mismo criterio que el bootstrap: cada entrypoint valida lo que usa, y el worker
 * —que sí los usa a todos— sigue validando el env completo con `getConfig()`.
 */
export function loadGmailEnv(source: NodeJS.ProcessEnv = process.env): GmailEnv {
  return parseEnv(gmailSchema, source);
}

export function loadSnovEnv(source: NodeJS.ProcessEnv = process.env): SnovEnv {
  return parseEnv(snovSchema, source);
}

export function loadEvalsEnv(source: NodeJS.ProcessEnv = process.env): EvalsEnv {
  return parseEnv(evalsSchema, source);
}

let cached: Config | undefined;

/**
 * Punto de entrada del worker. Se llama al arrancar para que un env incompleto
 * falle en el boot y no a mitad de una corrida.
 */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
