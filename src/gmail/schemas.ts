import { z } from 'zod';

/**
 * Formas de la API de Gmail que usamos. La librería tipa casi todo como
 * `string | null | undefined`, así que se parsea en vez de castear: si Google
 * cambia una forma, falla acá y no tres capas más abajo.
 */

export const headerSchema = z.object({
  name: z.string(),
  value: z.string().nullish(),
});

export interface PayloadGmail {
  mimeType?: string | null | undefined;
  filename?: string | null | undefined;
  headers?: Array<{ name: string; value?: string | null | undefined }> | null | undefined;
  body?: { size?: number | null | undefined; data?: string | null | undefined } | null | undefined;
  parts?: PayloadGmail[] | null | undefined;
}

export const payloadSchema: z.ZodType<PayloadGmail> = z.lazy(() =>
  z.object({
    mimeType: z.string().nullish(),
    filename: z.string().nullish(),
    headers: z.array(headerSchema).nullish(),
    body: z
      .object({
        size: z.number().nullish(),
        data: z.string().nullish(),
      })
      .nullish(),
    parts: z.array(payloadSchema).nullish(),
  }),
);

export const mensajeSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).nullish(),
  snippet: z.string().nullish(),
  internalDate: z.string().nullish(),
  payload: payloadSchema.nullish(),
});

export type MensajeGmail = z.infer<typeof mensajeSchema>;

export const hiloSchema = z.object({
  id: z.string(),
  messages: z.array(mensajeSchema).nullish(),
});

export const listaDeMensajesSchema = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string().nullish() })).nullish(),
  nextPageToken: z.string().nullish(),
  resultSizeEstimate: z.number().nullish(),
});

export const historialSchema = z.object({
  history: z
    .array(
      z.object({
        id: z.string().nullish(),
        messagesAdded: z
          .array(z.object({ message: z.object({ id: z.string(), threadId: z.string().nullish() }) }))
          .nullish(),
      }),
    )
    .nullish(),
  nextPageToken: z.string().nullish(),
  historyId: z.string().nullish(),
});

export const listaDeEtiquetasSchema = z.object({
  labels: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.string().nullish(),
        messagesTotal: z.number().nullish(),
      }),
    )
    .nullish(),
});

export const perfilSchema = z.object({
  emailAddress: z.string().nullish(),
  historyId: z.string().nullish(),
  messagesTotal: z.number().nullish(),
});

/** Lo que devuelve `users.labels.create`. */
export const etiquetaCreadaSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/** Lo que devuelve `users.drafts.create`. */
export const draftCreadoSchema = z.object({
  id: z.string(),
  message: z.object({ id: z.string().optional(), threadId: z.string().optional() }).optional(),
});
