import { z } from 'zod';

/**
 * Formas de la API de Snov, verificadas contra la cuenta real (agosto 2026).
 * Se parsean en vez de castear: si Snov cambia algo, falla acá con un mensaje
 * claro y no tres capas más abajo con un `undefined`.
 */

export const tokenSchema = z.object({
  success: z.boolean().optional(),
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  /** Verificado: 3600 segundos. */
  expires_in: z.number(),
});

export const listaDeSnovSchema = z.object({
  id: z.number(),
  name: z.string(),
});

export const campanaDelProspectSchema = z.object({
  id: z.number(),
  name: z.string(),
  campaign_status: z.string().nullish(),
  recipients: z
    .array(
      z.object({
        email: z.string().nullish(),
        recipient_status: z.string().nullish(),
        sent: z.string().nullish(),
        reply: z.string().nullish(),
      }),
    )
    .nullish(),
});

export const prospectSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  lists: z.array(listaDeSnovSchema).nullish(),
  campaigns: z.array(campanaDelProspectSchema).nullish(),
});

/**
 * `success: false` sin `data` es la respuesta para "no es un prospect nuestro".
 * No es un error: es la señal que responde la pregunta que Gmail no puede
 * —¿le escribimos alguna vez?— y de la que dependen la guarda de
 * `NO_ES_RESPUESTA` y el rescate de spam (SPEC.md).
 */
export const respuestaDeProspectsSchema = z.object({
  success: z.boolean(),
  data: z.array(prospectSchema).nullish(),
});

export const listasDelUsuarioSchema = z.array(
  z.object({
    id: z.number(),
    name: z.string(),
    contacts: z.number().nullish(),
    isDeleted: z.boolean().nullish(),
  }),
);

/**
 * Las listas de do-not-email. **No son las mismas que las de prospects**: viven
 * en Campaigns → Do-not-contact lists y no aparecen en `get-user-lists`.
 *
 * Deliberadamente laxo: se agregó para diagnosticar el 404 de
 * `add-to-do-not-email-list` (SPEC.md § do-not-email), sin conocer todavía la
 * forma exacta de la respuesta. `passthrough` deja ver los campos que vengan de
 * más en vez de esconderlos, que es justo lo que hace falta al explorar.
 */
export const listasDeDoNotEmailSchema = z
  .object({
    success: z.boolean().nullish(),
    data: z
      .array(
        z
          .object({
            id: z.union([z.number(), z.string()]).nullish(),
            name: z.string().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

/**
 * El verificador de emails de Snov. Dos pasos: se arranca una tarea y después se
 * consulta por `task_hash`.
 *
 * Los dos schemas son laxos a propósito: se agregaron para averiguar **si
 * verificar marca al prospect en su lista** — que es lo que decide si la campaña
 * arranca — y esconder campos es lo contrario de lo que hace falta al explorar.
 */
export const verificacionIniciadaSchema = z
  .object({
    // El hash viene **anidado en `data`**, no arriba. Se acepta en los dos lugares
    // porque la primera versión lo buscaba suelto y no lo encontraba:
    //   {"data":{"task_hash":"c331d0..."},"meta":{"emails":[...]}}
    data: z.object({ task_hash: z.string().nullish() }).passthrough().nullish(),
    task_hash: z.string().nullish(),
    status: z.string().nullish(),
  })
  .passthrough();

/** El hash, mire donde mire la respuesta. */
export function hashDeVerificacion(
  r: z.infer<typeof verificacionIniciadaSchema>,
): string | undefined {
  const h = r.data?.task_hash ?? r.task_hash;
  return h == null || h === '' ? undefined : h;
}

export const resultadoDeVerificacionSchema = z
  .object({
    status: z.string().nullish(),
    data: z.unknown().optional(),
  })
  .passthrough();

export type Prospect = z.infer<typeof prospectSchema>;
export type CampanaDelProspect = z.infer<typeof campanaDelProspectSchema>;
export type ListaDeSnov = z.infer<typeof listaDeSnovSchema>;
