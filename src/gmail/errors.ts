import { z } from 'zod';

/**
 * Errores de auth de Gmail, ya traducidos a algo accionable.
 *
 * El caso que importa: el refresh token se emite para los scopes que se
 * consintieron, no para los que dice `GMAIL_SCOPE`. Si alguien pasa el scope a
 * `gmail.modify` sin rehacer el consentimiento, el config bootea sin problema y la
 * primera llamada a Gmail devuelve un 403 de Google que no explica qué hacer.
 * Cuando eso pase va a ser tarde y nadie va a tener esta conversación a mano.
 */
export class GmailAuthError extends Error {
  readonly kind:
    | 'scope-insuficiente'
    | 'scope-excedido'
    | 'cuenta-equivocada'
    | 'consentimiento-revocado';

  constructor(kind: GmailAuthError['kind'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GmailAuthError';
    this.kind = kind;
  }
}

const errorItemSchema = z.object({
  reason: z.string().optional(),
  message: z.string().optional(),
});

/** Forma laxa de un GaxiosError. Se parsea en vez de castear (convención del repo). */
const googleErrorSchema = z.object({
  code: z.union([z.number(), z.string()]).optional(),
  status: z.union([z.number(), z.string()]).optional(),
  message: z.string().optional(),
  errors: z.array(errorItemSchema).optional(),
  response: z
    .object({
      status: z.number().optional(),
      data: z
        .object({
          // En la API de Gmail es un objeto; en el endpoint de token, un string.
          error: z
            .union([
              z.object({
                code: z.union([z.number(), z.string()]).optional(),
                message: z.string().optional(),
                status: z.string().optional(),
                errors: z.array(errorItemSchema).optional(),
              }),
              z.string(),
            ])
            .optional(),
          error_description: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

const RAZONES_DE_SCOPE = ['insufficientpermissions', 'insufficientscope', 'forbidden'];
const RAZONES_DE_REVOCACION = ['invalid_grant', 'unauthorized_client'];

function comoRehacerAuth(scopeConfigurado: string): string {
  return (
    `Rehacer el consentimiento: correr \`npm run auth:gmail\` con GMAIL_SCOPE=${scopeConfigurado} ` +
    'y pegar el refresh token nuevo en .env. Requiere a Ally: el consentimiento es sobre su cuenta.'
  );
}

/**
 * Traduce un error de Gmail a `GmailAuthError` cuando es un problema de scope o de
 * consentimiento. Cualquier otro error se devuelve tal cual: acá no se tragan
 * errores, solo se traducen los dos que tienen una acción concreta atrás.
 */
export function mapGmailError(error: unknown, ctx: { scopeConfigurado: string }): unknown {
  const parsed = googleErrorSchema.safeParse(error);
  if (!parsed.success) return error;

  const e = parsed.data;
  const data = e.response?.data;
  const errorAnidado = typeof data?.error === 'object' ? data.error : undefined;
  const errorComoString = typeof data?.error === 'string' ? data.error : undefined;

  const status = Number(e.response?.status ?? e.status ?? e.code);
  const razones = [...(e.errors ?? []), ...(errorAnidado?.errors ?? [])]
    .map((r) => r.reason?.toLowerCase())
    .filter((r): r is string => r !== undefined);

  const textos = [e.message, errorAnidado?.message, errorComoString, data?.error_description]
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.toLowerCase());

  const esScope =
    razones.some((r) => RAZONES_DE_SCOPE.includes(r)) ||
    textos.some((t) => t.includes('insufficient authentication scopes')) ||
    textos.some((t) => t.includes('insufficient permission')) ||
    textos.some((t) => t.includes('invalid_scope')) ||
    (status === 403 && razones.length === 0 && textos.length === 0);

  if (esScope) {
    return new GmailAuthError(
      'scope-insuficiente',
      `Gmail rechazó la llamada por permisos insuficientes: el refresh token no cubre "${ctx.scopeConfigurado}". ` +
        'Pasa cuando se cambia GMAIL_SCOPE sin rehacer el consentimiento OAuth. ' +
        comoRehacerAuth(ctx.scopeConfigurado),
      { cause: error },
    );
  }

  const esRevocacion =
    razones.some((r) => RAZONES_DE_REVOCACION.includes(r)) ||
    (errorComoString !== undefined && RAZONES_DE_REVOCACION.includes(errorComoString)) ||
    textos.some((t) => t.includes('token has been expired or revoked'));

  if (esRevocacion) {
    return new GmailAuthError(
      'consentimiento-revocado',
      'El refresh token de Gmail ya no sirve: se revocó el consentimiento o se cambió la contraseña de la cuenta. ' +
        comoRehacerAuth(ctx.scopeConfigurado),
      { cause: error },
    );
  }

  return error;
}
