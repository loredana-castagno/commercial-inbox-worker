/** Taxonomía de SPEC.md. Cualquier cambio se hace primero en el SPEC. */
export const CATEGORIES = [
  'OOO',
  'UNSUBSCRIBE',
  'UNDELIVERABLE',
  'NO_THANKS',
  'NOT_NOW',
  'REFERRAL',
  'EMAIL_MODIFIED',
  'NOT_RIGHT_CONTACT',
  'HOT',
  'WARMUP',
  'WEBSITE_CONTACT',
  // Newsletters, notificaciones, alertas: mail que no participa del proceso.
  // Sin esta categoría todo eso cae en OTHER y tapa la métrica del shadow mode.
  'NO_ES_RESPUESTA',
  // Interés real pero oportunidad sin confirmar. Es el escalón previo a HOT y el
  // techo de NOT_NOW: queda en el inbox y lo resuelve una persona.
  'TO_MANUAL_SORT',
  'OTHER',
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Categorías que nunca pueden ejecutarse sin revisión humana (SPEC.md § Ruteo). */
export const NEVER_AUTOMATED: readonly Category[] = [
  'HOT',
  'TO_MANUAL_SORT',
  'OTHER',
  // Los contactos por la web llegan desde una dirección @mycompany —los manda el
  // formulario del sitio— así que el prefiltro de dominios propios los descarta
  // antes de clasificarlos. La categoría es inalcanzable en la práctica; está acá
  // para que, si algún día el formulario manda desde otro dominio, el mail vaya a
  // una persona en vez de crear un contacto en el CRM solo (SPEC.md § 11).
  'WEBSITE_CONTACT',
];

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}
