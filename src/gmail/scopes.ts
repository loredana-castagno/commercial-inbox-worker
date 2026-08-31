/**
 * Comparación de scopes de Gmail.
 *
 * No alcanza con comparar strings: un token de `gmail.modify` cubre
 * funcionalmente a `gmail.readonly`, pero el string concedido es distinto. Y al
 * revés, un token de `readonly` refresca perfecto y recién falla cuando se pide
 * `modify` — por eso el preflight compara scopes y no "que el refresh ande".
 */

const MAIL_GOOGLE = 'https://mail.google.com/';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const METADATA = 'https://www.googleapis.com/auth/gmail.metadata';

/** Qué cubre cada scope, además de sí mismo. */
const IMPLICA: Record<string, readonly string[]> = {
  [MAIL_GOOGLE]: [MODIFY, READONLY, METADATA],
  [MODIFY]: [READONLY, METADATA],
  [READONLY]: [METADATA],
};

export function parseScopes(valor: string): string[] {
  return valor
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function cubre(concedido: string, requerido: string): boolean {
  if (concedido === requerido) return true;
  return (IMPLICA[concedido] ?? []).includes(requerido);
}

/** Un scope que da acceso al correo, en cualquier grado. */
export function esScopeDeGmail(scope: string): boolean {
  return scope === MAIL_GOOGLE || scope.includes('/auth/gmail.');
}

export interface ComparacionDeScopes {
  /** Scopes pedidos por GMAIL_SCOPE que el token no cubre. */
  faltantes: string[];
  /**
   * Scopes de correo que el token concede de más. Son error: durante las Fases 1-3
   * la barrera dura es que el token *no pueda* escribir (CLAUDE.md #3), y un token
   * con `modify` bajo un `GMAIL_SCOPE=readonly` deja esa barrera en nada.
   */
  excedentesDeGmail: string[];
  /**
   * Scopes de más que no tocan el correo (`openid`, `userinfo.email`). Google los
   * agrega solo en algunas configuraciones del consent screen. No pueden leer ni
   * escribir mails, así que se informan pero no frenan el arranque.
   */
  excedentesAjenos: string[];
}

export function compararScopes(concedidos: string[], requeridos: string[]): ComparacionDeScopes {
  const faltantes = requeridos.filter((req) => !concedidos.some((con) => cubre(con, req)));

  const excedentes = concedidos.filter((con) => !requeridos.some((req) => cubre(req, con)));

  return {
    faltantes,
    excedentesDeGmail: excedentes.filter(esScopeDeGmail),
    excedentesAjenos: excedentes.filter((s) => !esScopeDeGmail(s)),
  };
}
