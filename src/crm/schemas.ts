import { z } from 'zod';

/**
 * Lo que devuelve `/api/leads/from-email`, parseado con Zod.
 *
 * Se valida solo lo que se usa y el resto pasa. El CRM es otro repo con su propio
 * ciclo de deploy: un campo nuevo del lado de ellos no tiene por qué romper una
 * corrida acá.
 */

const campaignInfoSchema = z
  .object({
    /** Texto ya armado: `🚀 Active in "X" (Step 2)`. */
    statusText: z.string().optional(),
    hasReplied: z.boolean().optional(),
  })
  .passthrough();

const contactoSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    fullName: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    owner: z.unknown().optional(),
  })
  .passthrough();

/**
 * El `GET` devuelve **200 aunque el contacto no exista**. Que "no existe" sea una
 * respuesta exitosa y no un 404 es lo que hace que este endpoint sirva como
 * consulta: un 404 obligaría a distinguir "no está" de "la ruta está mal".
 */
export const consultaDeContactoSchema = z
  .object({
    exists: z.boolean(),
    type: z.string().nullable().optional(),
    archived: z.boolean().optional(),
    suggestedTarget: z.string().nullable().optional(),
    matchedAccount: z.unknown().optional(),
    campaignInfo: campaignInfoSchema.nullable().optional(),
    lead: contactoSchema.nullable().optional(),
    contact: contactoSchema.nullable().optional(),
    notesCount: z.number().optional(),
    historyBrief: z.string().nullable().optional(),
  })
  .passthrough();

export type ConsultaDeContacto = z.infer<typeof consultaDeContactoSchema>;

/**
 * El `POST` no devuelve un `created` limpio: se distingue por la forma.
 *
 * - creó → `{ success, id, type, url, message }`
 * - existía y cambió algo → `{ success, restored, alreadyLogged, id }`
 * - existía y no cambió nada → **409** `{ duplicate: true, id }`, que se maneja
 *   como éxito idempotente en `CrmWriter` y por eso no aparece en este schema.
 */
export const altaDeContactoSchema = z
  .object({
    success: z.boolean().optional(),
    id: z.union([z.string(), z.number()]).optional(),
    type: z.string().optional(),
    url: z.string().optional(),
    message: z.string().optional(),
    restored: z.boolean().optional(),
    alreadyLogged: z.boolean().optional(),
  })
  .passthrough();

export type AltaDeContacto = z.infer<typeof altaDeContactoSchema>;
