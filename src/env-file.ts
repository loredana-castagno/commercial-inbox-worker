/**
 * Edición puntual del archivo .env.
 *
 * Existe para que `auth:gmail` escriba el refresh token solo, en vez de
 * imprimirlo y confiar en un copiar-pegar. El paso manual falló tres veces
 * seguidas —una por una URL cortada, otra por copiar mal, otra por no copiarlo—
 * y además hacía que la credencial viajara por la terminal y por el chat.
 *
 * La función es pura para poder testear lo único que importa: que no se lleve
 * puesto el resto del archivo.
 */

/**
 * Reemplaza el valor de `clave`, o lo agrega al final si no está.
 *
 * Conserva comentarios, orden, líneas en blanco y el estilo de salto de línea.
 * Solo toca la línea de la clave.
 */
export function reemplazarVariable(contenido: string, clave: string, valor: string): string {
  const usaCRLF = contenido.includes('\r\n');
  const salto = usaCRLF ? '\r\n' : '\n';
  const lineas = contenido.split(/\r?\n/);

  const nueva = `${clave}=${valor}`;
  let reemplazada = false;

  const resultado = lineas.map((linea) => {
    // Solo la asignación real: un comentario que mencione la clave no se toca.
    if (!reemplazada && new RegExp(`^\\s*${clave}\\s*=`).test(linea)) {
      reemplazada = true;
      return nueva;
    }
    return linea;
  });

  if (!reemplazada) {
    // Si el archivo termina con línea vacía, escribir antes de ella.
    if (resultado.at(-1) === '') resultado.splice(resultado.length - 1, 0, nueva);
    else resultado.push(nueva);
  }

  return resultado.join(salto);
}

/** Lee el valor de una clave, para verificar después de escribir. */
export function leerVariable(contenido: string, clave: string): string | null {
  for (const linea of contenido.split(/\r?\n/)) {
    const match = new RegExp(`^\\s*${clave}\\s*=(.*)$`).exec(linea);
    if (match) return (match[1] ?? '').trim();
  }
  return null;
}
