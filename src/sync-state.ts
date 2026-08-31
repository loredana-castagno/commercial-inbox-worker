import { getDb } from './db.js';

/** Una sola fila, con id fijo. El cursor del worker contra Gmail. */
const ID_FIJO = 1;

export interface EstadoDeSync {
  historyId: string | null;
  lastMessageDate: Date | null;
  lastRunAt: Date | null;
  /** `null` = nunca se barrió Spam. La primera corrida lo hace. */
  lastSpamSweepAt: Date | null;
}

export async function leerEstadoDeSync(): Promise<EstadoDeSync> {
  const db = await getDb();
  const fila = await db.syncState.findUnique({ where: { id: ID_FIJO } });

  return {
    historyId: fila?.historyId ?? null,
    lastMessageDate: fila?.lastMessageDate ?? null,
    lastRunAt: fila?.lastRunAt ?? null,
    lastSpamSweepAt: fila?.lastSpamSweepAt ?? null,
  };
}

/**
 * Avanza el cursor. Se llama **después** de procesar con éxito: si el worker
 * muere a mitad de un batch, la corrida siguiente vuelve a traer esos mensajes y
 * la PK de `EmailTriage` se encarga de que no se dupliquen.
 */
export async function guardarEstadoDeSync(estado: {
  historyId?: string | null;
  lastMessageDate?: Date | null;
  lastRunAt?: Date;
  lastSpamSweepAt?: Date;
}): Promise<void> {
  const db = await getDb();

  const datos = {
    ...(estado.historyId === undefined ? {} : { historyId: estado.historyId }),
    ...(estado.lastMessageDate === undefined ? {} : { lastMessageDate: estado.lastMessageDate }),
    ...(estado.lastSpamSweepAt === undefined ? {} : { lastSpamSweepAt: estado.lastSpamSweepAt }),
    lastRunAt: estado.lastRunAt ?? new Date(),
  };

  await db.syncState.upsert({
    where: { id: ID_FIJO },
    create: { id: ID_FIJO, ...datos },
    update: datos,
  });
}
