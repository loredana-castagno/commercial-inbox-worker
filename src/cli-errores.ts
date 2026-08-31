import { GmailAuthError } from './gmail/errors.js';

/**
 * Handler de errores para los scripts de CLI.
 *
 * `GmailAuthError` guarda el error original en `cause`, que es lo correcto para
 * depurar. El costo es que si el error sale sin capturar, Node imprime la cadena
 * entera: cientos de líneas de un GaxiosError con el body como buffer, y el
 * mensaje accionable perdido arriba de todo.
 *
 * Estos scripts los corre Ally, no nosotros. Cuando el error es uno de los que ya
 * sabemos explicar, se imprime solo la explicación. Para cualquier otro error se
 * imprime todo, porque ahí el detalle es lo único que hay.
 */
export function instalarManejadorDeErrores(): void {
  const manejar = (error: unknown): never => {
    if (error instanceof GmailAuthError) {
      console.error(`\n✖ ${error.message}\n`);
      console.error(`(detalle técnico: ${(error.cause as Error | undefined)?.message ?? 'sin causa'})`);
      process.exit(1);
    }

    console.error(error);
    process.exit(1);
  };

  process.on('uncaughtException', manejar);
  process.on('unhandledRejection', manejar);
}
