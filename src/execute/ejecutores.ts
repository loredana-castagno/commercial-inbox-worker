import { aDecimal, type CrmWriter } from '../crm/escritor.js';
import type { GmailWriter } from '../gmail/escritor.js';
import {
  asuntoDeRespuesta,
  esNombreDePlantilla,
  normalizarNombre,
  primerNombre,
  renderizar,
} from './plantillas.js';
import type { SnovWriter } from '../snov/escritor.js';
import type { Accion } from './acciones.js';

/**
 * El puente entre una acción y el servicio que la realiza.
 *
 * El executor decide **si** una acción sale; esto decide **cómo**. Están separados
 * porque son dos preguntas con dueños distintos: las barreras son política, y esto
 * es plomería.
 *
 * La regla que gobierna todo el módulo: **una acción que no se sabe ejecutar tira,
 * no se ignora.** Si el executor la dejó pasar y acá no hay quien la haga, tragarla
 * en silencio la marcaría como ejecutada y el Sheet diría que el bot hizo algo que
 * no hizo. Tirando, queda `fallida` con el motivo a la vista.
 */

export interface ClientesDeEscritura {
  /** `undefined` cuando `EXTERNAL_WRITE_ENABLED` está apagado. */
  readonly snov?: SnovWriter | undefined;
  /** `undefined` cuando `GMAIL_WRITE_ENABLED` está apagado. */
  readonly gmail?: GmailWriter | undefined;
  /** `undefined` cuando `EXTERNAL_WRITE_ENABLED` está apagado. */
  readonly crm?: CrmWriter | undefined;
  /**
   * El id de `Do-not-email (full list)` (`SNOV_DO_NOT_EMAIL_LIST`), la lista que
   * usan las campañas de Ally.
   *
   * **La cuenta tiene siete listas de do-not-contact**, dos con decenas de miles
   * de entradas. Una baja en la equivocada responde 200 y deja al prospect
   * recibiendo igual, sin ningún síntoma — por eso viaja explícito y no se deja
   * que Snov elija.
   */
  readonly listaDeDoNotEmail?: string | undefined;
}

/**
 * Datos del mail que algunas acciones necesitan y la acción no lleva.
 *
 * Las acciones son la *decisión*; esto es el mail sobre el que se decidió. Que
 * viajen separados es lo que deja a los handlers puros: deciden sin conocer el
 * cuerpo del mensaje.
 */
export interface ContextoDeEjecucion {
  readonly emailDelRemitente: string;
  readonly nombreDelRemitente: string | null;
  /** Id de Gmail en hexadecimal, tal como viene. Se convierte al mandarlo. */
  readonly gmailMessageId: string;
  readonly gmailThreadId: string;
  readonly asunto: string | null;
  readonly cuerpo: string;
  /**
   * El nombre de pila, ya resuelto por el worker: lo extrae el clasificador —que
   * ve la firma y el cuerpo, no solo el header— con el heurístico de
   * `primerNombre()` como respaldo.
   *
   * Viaja resuelto y no se recalcula acá para que **el saludo del draft y el
   * `firstName` que va a Snov sean siempre el mismo dato**. Cuando cada uno lo
   * derivaba por su cuenta, no había nada que garantizara que coincidieran.
   */
  readonly primerNombreDelRemitente?: string | undefined;
  /**
   * El `Message-ID` de RFC 5322 del mail original, para el `In-Reply-To`. Sin él
   * el draft cae en el hilo por `threadId` igual, pero algunos clientes lo
   * muestran suelto.
   */
  readonly messageIdRfc822?: string | undefined;
}

function faltaCliente(que: string, comoSeHabilita: string): Error {
  return new Error(`no hay cliente de ${que} conectado (${comoSeHabilita})`);
}

/**
 * Arma el callback que recibe `ejecutar()`.
 *
 * Devuelve `undefined` cuando no hay ningún cliente conectado, que es lo que hace
 * que el executor marque todo como planeado en vez de fingir que ejecutó.
 */
export function crearEjecutor(
  clientes: ClientesDeEscritura,
  contexto: ContextoDeEjecucion,
): ((accion: Accion) => Promise<void>) | undefined {
  if (clientes.snov === undefined && clientes.gmail === undefined && clientes.crm === undefined) {
    return undefined;
  }

  return async (accion: Accion): Promise<void> => {
    switch (accion.tipo) {
      case 'SUBIR_A_LISTA_SNOV': {
        if (clientes.snov === undefined) {
          throw faltaCliente('Snov', 'EXTERNAL_WRITE_ENABLED=true');
        }
        // La acción trae su propio email cuando no coincide con el remitente:
        // EMAIL_MODIFIED sube la dirección nueva y REFERRAL sube al referido.
        //
        // El **nombre** distingue esos dos casos, y la diferencia importa:
        //  - `EMAIL_MODIFIED` no manda nombre → se usa el del remitente. Es la misma
        //    persona: cambió la dirección, no el nombre.
        //  - `REFERRAL` manda el del referido → es **otra persona**, y usar el del
        //    remitente dejaría a Chris Palmer cargado en Snov como "Alex Turner".
        //
        // `firstName` va aparte de `fullName`: son dos variables de sistema
        // distintas en Snov ({{first_name}} y {{full_name}}), no una derivada de
        // la otra. Sin este campo, un prospect que se crea acá por primera vez
        // —el caso normal de EMAIL_MODIFIED y de REFERRAL, que son siempre
        // direcciones nuevas para Snov— saluda con el {{first_name}} vacío en toda
        // campaña que lo use.
        //
        // El del remitente viaja ya resuelto desde el worker para que el saludo del
        // draft y el `firstName` de Snov sean el mismo dato; el del referido se
        // deriva acá porque no hay draft para el referido con el que coordinarlo.
        const nombreCompleto = accion.nombre ?? contexto.nombreDelRemitente;
        const nombreDePila =
          accion.nombre === undefined
            ? contexto.primerNombreDelRemitente
            : primerNombre(normalizarNombre(accion.nombre));
        await clientes.snov.agregarALista(
          accion.email ?? contexto.emailDelRemitente,
          accion.listaId,
          {
            ...(nombreCompleto === null ? {} : { fullName: nombreCompleto }),
            ...(nombreDePila === undefined ? {} : { firstName: nombreDePila }),
          },
        );
        return;
      }

      case 'SUBIR_A_DO_NOT_EMAIL': {
        if (clientes.snov === undefined) {
          throw faltaCliente('Snov', 'EXTERNAL_WRITE_ENABLED=true');
        }
        if (clientes.listaDeDoNotEmail === undefined) {
          // Tirar y no elegir una por default: con siete listas en la cuenta,
          // adivinar significa dar de baja en la lista equivocada —200 y sin
          // ningún síntoma— sobre la única acción del sistema que no se deshace.
          throw new Error(
            'falta el id de la lista de do-not-email (SNOV_DO_NOT_EMAIL_LIST): ' +
              'la cuenta tiene varias y no se elige una a ciegas',
          );
        }
        // El email viene en la acción y no del contexto: los handlers lo ponen ahí
        // después de comprobar que no es un dominio nuestro.
        await clientes.snov.agregarADoNotEmail(accion.email, clientes.listaDeDoNotEmail);
        return;
      }

      case 'ETIQUETAR_REVISION':
      case 'ETIQUETAR': {
        if (clientes.gmail === undefined) {
          throw faltaCliente('Gmail', 'GMAIL_WRITE_ENABLED=true y GMAIL_SCOPE=gmail.modify');
        }
        await clientes.gmail.etiquetar(contexto.gmailMessageId, accion.etiqueta);
        return;
      }

      case 'SACAR_DE_INBOX': {
        if (clientes.gmail === undefined) {
          throw faltaCliente('Gmail', 'GMAIL_WRITE_ENABLED=true y GMAIL_SCOPE=gmail.modify');
        }
        // Quita la etiqueta INBOX. Nunca borra ni manda a la papelera.
        await clientes.gmail.sacarDelInbox(contexto.gmailMessageId);
        return;
      }

      case 'CREAR_DRAFT': {
        if (clientes.gmail === undefined) {
          throw faltaCliente('Gmail', 'GMAIL_WRITE_ENABLED=true y GMAIL_SCOPE=gmail.modify');
        }
        if (!esNombreDePlantilla(accion.template)) {
          // Una plantilla que no existe no se sustituye por otra ni se saltea: el
          // draft saldría con el texto equivocado y nadie lo notaría.
          throw new Error(`no existe la plantilla "${accion.template}"`);
        }

        const nombre = contexto.primerNombreDelRemitente;
        await clientes.gmail.crearDraft({
          threadId: contexto.gmailThreadId,
          para: contexto.emailDelRemitente,
          asunto: asuntoDeRespuesta(contexto.asunto),
          // Sin `tecnologia`: el clasificador no la extrae, así que queda como XXX
          // — que es lo que Ally deja cuando le falta el dato.
          cuerpo: renderizar(accion.template, nombre === undefined ? {} : { nombre }),
          ...(contexto.messageIdRfc822 === undefined
            ? {}
            : { enRespuestaA: contexto.messageIdRfc822 }),
        });
        return;
      }

      case 'CREAR_LEAD_CRM': {
        if (clientes.crm === undefined) {
          throw faltaCliente('CRM', 'EXTERNAL_WRITE_ENABLED=true y CRM_SERVICE_TOKEN');
        }
        await clientes.crm.crearContacto({
          email: contexto.emailDelRemitente,
          ...(contexto.nombreDelRemitente === null
            ? {}
            : { fullName: contexto.nombreDelRemitente }),
          // Obligatorio: sin esto el CRM crea una Note nueva —y una llamada al
          // LLM— cada vez que reprocesamos el mismo rango.
          gmailMsgIdDec: aDecimal(contexto.gmailMessageId),
          ...(contexto.asunto === null ? {} : { subject: contexto.asunto }),
          bodyText: contexto.cuerpo,
        });
        return;
      }

      case 'DEJAR_EN_INBOX':
      case 'REVISION_HUMANA':
        // El executor no manda acá las acciones de barrera 'ninguna'. Si llegara
        // una, es un bug del executor y se prefiere ruidoso.
        throw new Error(`${accion.tipo} no debería llegar al ejecutor: no sale del sistema`);
    }
  };
}
