import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { CredencialDeServicio } from './cliente.js';

/**
 * Carga la clave de la service account desde el JSON que baja Google Cloud.
 *
 * La ruta se resuelve a absoluta contra la raíz del repo por el mismo motivo que
 * `database-url.ts`: bajo PM2 el cwd no es necesariamente la raíz, y una ruta
 * relativa fallaría en el servidor y no acá (CLAUDE.md § Windows/Linux).
 *
 * El JSON **no se commitea**: vive en `secrets/`, que está en `.gitignore`. La
 * clave privada tampoco va al `.env` — son 1700 caracteres con saltos de línea
 * escapados, y un `.env` los rompe en silencio.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Solo los dos campos que se usan. El resto del JSON no se valida ni se lee. */
const credencialSchema = z.object({
  type: z.literal('service_account'),
  client_email: z.string().email(),
  private_key: z.string().min(1),
});

export function resolverRutaDeCredencial(ruta: string): string {
  return path.isAbsolute(ruta) ? ruta : path.resolve(projectRoot, ruta);
}

export function cargarCredencial(ruta: string): CredencialDeServicio {
  const absoluta = resolverRutaDeCredencial(ruta);

  if (!fs.existsSync(absoluta)) {
    throw new Error(
      `No existe el JSON de la service account en ${absoluta}. ` +
        'Es el archivo que baja Google Cloud Console; va en secrets/, nunca en el repo.',
    );
  }

  let crudo: unknown;
  try {
    crudo = JSON.parse(fs.readFileSync(absoluta, 'utf8'));
  } catch (e) {
    throw new Error(`El JSON de la service account no se puede parsear: ${(e as Error).message}`);
  }

  const resultado = credencialSchema.safeParse(crudo);
  if (!resultado.success) {
    // Sin detalle del error: los issues de Zod pueden incluir el valor recibido, y
    // acá el valor es una clave privada.
    throw new Error(
      `${absoluta} no parece una clave de service account ` +
        '(faltan "type": "service_account", "client_email" o "private_key").',
    );
  }

  return { client_email: resultado.data.client_email, private_key: resultado.data.private_key };
}
