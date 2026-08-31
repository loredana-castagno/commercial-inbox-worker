import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Raíz del repo, tanto corriendo desde `src/` con tsx como desde `dist/`.
 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Prisma 7 ya no resuelve la ruta del SQLite desde el schema: la abre
 * better-sqlite3, que la interpreta contra el cwd del proceso. Bajo PM2 el cwd no
 * es necesariamente la raíz del repo, así que se resuelve a absoluta acá y en un
 * solo lugar. Sin esto, un `pm2 start` desde otro directorio crea una base vacía
 * en vez de fallar, que es la peor forma de romperse.
 */
export function resolveDatabaseFile(url: string | undefined = process.env.DATABASE_URL): string {
  if (!url || url.trim() === '') {
    throw new Error('DATABASE_URL no está definida.');
  }

  const raw = url.startsWith('file:') ? url.slice('file:'.length) : url;

  if (raw === ':memory:') return raw;

  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}
