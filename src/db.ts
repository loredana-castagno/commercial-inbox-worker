import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { resolveDatabaseFile } from './database-url.js';
import { PrismaClient } from './generated/prisma/client.js';

let client: PrismaClient | undefined;

/**
 * WAL permite que un lector (por ejemplo un script de inspección) no bloquee al
 * worker. journal_mode se persiste en el archivo, pero se re-aplica en cada boot
 * para que una base recién creada quede en el modo correcto.
 *
 * En Prisma 7 la conexión la abre el driver adapter, no el engine de Rust, así que
 * los PRAGMA se aplican igual pero sobre la conexión de better-sqlite3.
 */
export async function getDb(): Promise<PrismaClient> {
  if (client) return client;

  const adapter = new PrismaBetterSqlite3({ url: `file:${resolveDatabaseFile()}` });
  const db = new PrismaClient({ adapter });

  const [mode] = await db.$queryRawUnsafe<Array<{ journal_mode: string }>>(
    'PRAGMA journal_mode = WAL;',
  );

  if (mode?.journal_mode.toLowerCase() !== 'wal') {
    await db.$disconnect();
    throw new Error(`No se pudo activar WAL en SQLite (journal_mode = ${mode?.journal_mode}).`);
  }

  // Sin esto, dos escritores concurrentes dan SQLITE_BUSY inmediato en vez de esperar.
  await db.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');
  await db.$queryRawUnsafe('PRAGMA foreign_keys = ON;');

  client = db;
  return client;
}

export async function closeDb(): Promise<void> {
  if (!client) return;
  await client.$disconnect();
  client = undefined;
}
