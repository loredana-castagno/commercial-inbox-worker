import { CATEGORIES } from '../categories.js';

/**
 * El prompt del clasificador.
 *
 * **El LLM decide categoría, entidades y confianza. Nada más** (CLAUDE.md).
 * Acá no entra `campañaOrigen`, ni si el prospect ya está en una lista, ni si son
 * dos campañas: eso lo resuelve el executor con el dato de Snov. Si el prompt
 * viera ese contexto empezaría a inferir consecuencias —"ya está en Not now,
 * entonces…"— y las reglas de negocio se mudarían al único lugar del sistema donde
 * no se pueden testear sin gastar tokens.
 *
 * Por la misma razón el prompt tampoco menciona listas de Snov, labels de Gmail ni
 * el CRM: describe qué *es* cada categoría, no qué hacer con ella.
 */

interface DescripcionDeCategoria {
  cuando: string;
  clave?: string;
  /**
   * Pares de contraste con la categoría vecina. Solo donde la frontera se probó
   * difícil de verdad: sobrecargar el prompt de ejemplos tiene su propio costo.
   */
  contraste?: ReadonlyArray<{ texto: string; categoria: string; porque: string }>;
}

/**
 * Una entrada por categoría de `CATEGORIES`. El tipo `Record` obliga a que estén
 * todas: agregar una categoría al SPEC sin describirla acá no compila.
 */
const DESCRIPCIONES: Record<(typeof CATEGORIES)[number], DescripcionDeCategoria> = {
  OOO: {
    cuando: 'Auto-respuesta de ausencia temporal (vacaciones, licencia, fuera de la oficina).',
    clave: 'Extraer fechaRetorno si la menciona. Si dice que dejó la empresa, NO es OOO.',
  },
  UNSUBSCRIBE: {
    cuando:
      'Pide explícitamente no recibir más correos, o su desinterés es permanente. También cuando dejó la empresa y NO deja a nadie en su lugar.',
    clave:
      'Requiere señal de permanencia: "remove me", "stop emailing", "opt-out", "no longer with the company". Un "no gracias" NO alcanza. Si dejó la empresa y SÍ deja un reemplazo con nombre y mail, es REFERRAL (marcá dejoLaEmpresa igual).',
  },
  UNDELIVERABLE: {
    cuando: 'Rebote técnico: la dirección no existe o no puede recibir. Suele venir de un mailer-daemon.',
  },
  NO_THANKS: {
    cuando: 'Negativa neutra sin marca temporal: "no thanks", "we are good", "no need", "all set".',
    clave: 'No es una baja: puede interesarse en el futuro.',
  },
  NOT_NOW: {
    cuando:
      'Dice que ahora no tiene necesidad o búsquedas abiertas, o pide que lo contacten más adelante.',
    clave:
      'La frontera con NO_THANKS es difusa y no es grave confundirlas: las dos son negativas neutras.',
  },
  REFERRAL: {
    cuando:
      'Deriva a OTRA PERSONA y da datos suficientes para contactarla: al menos un nombre y un mail. ' +
      'Incluye el caso de quien dejó la empresa y deja un reemplazo ("X is no longer with us, please contact Y").',
    clave:
      'Si solo da una dirección genérica (info@, contact@, ChiefOperatingOfficer@) o solo un teléfono, NO es REFERRAL: es NOT_RIGHT_CONTACT. ' +
      'Y no lo confundas con EMAIL_MODIFIED: acá la dirección que da es de OTRA persona.',
    contraste: [
      {
        texto:
          'Alex Turner is no longer with Northwind Traders. For immediate assistance, please contact Chris Palmer (cpalmer@northwind.com).',
        categoria: 'REFERRAL',
        porque:
          'la dirección que deja es de otra persona, con nombre: es una derivación, no un cambio de dirección. dejoLaEmpresa: true',
      },
      {
        texto: 'I have left the company. Please direct all inquiries to our main office.',
        categoria: 'UNSUBSCRIBE',
        porque: 'se fue y no deja a nadie concreto: no hay a quién derivar',
      },
    ],
  },
  EMAIL_MODIFIED: {
    cuando:
      'Auto-respuesta avisando que LA MISMA PERSONA cambió de dirección, e indica su dirección nueva.',
    clave:
      'La dirección nueva tiene que ser DE LA MISMA PERSONA que escribió. Si la dirección es de otra persona, no es EMAIL_MODIFIED: es REFERRAL si viene con nombre, y UNSUBSCRIBE si no deja a nadie utilizable.',
    contraste: [
      {
        texto: 'Please note my email address has changed to j.smith@newdomain.com.',
        categoria: 'EMAIL_MODIFIED',
        porque: 'la misma persona con otra casilla: hay a quién migrar',
      },
      {
        texto:
          'I am no longer at this company. Please contact my colleague Maria Gonzalez at maria@acme.com.',
        categoria: 'REFERRAL',
        porque: 'también es un auto-reply con una dirección nueva, pero es de otra persona',
      },
    ],
  },
  NOT_RIGHT_CONTACT: {
    cuando: 'Dice que no es la persona indicada pero no deja un contacto alternativo utilizable.',
    clave: 'Lo que lo separa de REFERRAL es que no hay a quién escribirle.',
  },
  HOT: {
    cuando:
      'Interés comercial confirmado: pide una llamada, describe una búsqueda abierta, o pide propuesta o precios.',
    clave:
      'Tiene que haber una oportunidad concreta. Si contesta con interés pero repregunta sin confirmar que hay algo, es TO_MANUAL_SORT.',
  },
  WARMUP: {
    cuando: 'Correo de calentamiento de cuenta entre herramientas de envío. No es una persona real respondiendo.',
  },
  WEBSITE_CONTACT: {
    cuando: 'Alguien que escribió por el formulario de la web, no como respuesta a una campaña.',
  },
  NO_ES_RESPUESTA: {
    cuando:
      'Newsletters, notificaciones de servicios, alertas automáticas, facturas, invitaciones a webinars. Mail legítimo que no es la respuesta de un prospect.',
    clave:
      'Ante la duda NO uses esta categoría: se archiva y nadie la vuelve a mirar. Si podría ser una respuesta real, usá OTHER.',
  },
  TO_MANUAL_SORT: {
    cuando:
      'Hay interés o apertura, pero NO se puede afirmar que exista una oportunidad. Se llega por dos caminos opuestos:\n' +
      '(a) BAJANDO DE HOT: contesta con interés pero repregunta, así que todavía no hay oportunidad confirmada. "Which position exactly?", "How can I help you?".\n' +
      '(b) SUBIENDO DE NOT_NOW: dice que no, pero **hizo algo más que declinar**. Contestó una pregunta concreta que se le hizo, explicó cómo trabaja su empresa, o afirmó que va a haber oportunidad más adelante.',
    clave:
      'Para el camino (b), la diferencia con NOT_NOW NO está en las palabras del rechazo ni en si promete volver a contactar — eso lo dicen casi todos por cortesía. Está en si la persona aportó algo: información, una respuesta puntual, o una afirmación sobre el futuro. Ante la duda entre HOT y esto, elegí esto; ante la duda entre esto y NOT_NOW, mirá si aportó algo.',
    contraste: [
      {
        texto: 'At this point we have no updates but will be sure to reach out if ever that changes.',
        categoria: 'NOT_NOW',
        porque: 'promete volver a contactar, pero es la fórmula de cortesía: no aportó nada',
      },
      {
        texto: 'At this point we don\'t have a need. All the best.',
        categoria: 'NOT_NOW',
        porque: 'negativa lisa',
      },
      {
        texto:
          'I\'m sure we will. Once we get a better feel for our clients\' needs in 2025 we can determine when would be a good time to engage you.',
        categoria: 'TO_MANUAL_SORT',
        porque: 'afirma que va a haber ("I\'m sure we will") y propone cuándo retomar',
      },
      {
        texto:
          'Thanks for your email, but the situation is unchanged. In addition, we work with regional partners in most cases.',
        categoria: 'TO_MANUAL_SORT',
        porque: 'explica cómo trabajan: aportó información que no le pidieron',
      },
      {
        texto: 'Hello Allison -- yes, it has been filled.',
        categoria: 'TO_MANUAL_SORT',
        porque: 'contesta la pregunta concreta que se le hizo, en vez de despachar el mail',
      },
    ],
  },
  OTHER: {
    cuando: 'No encaja en ninguna de las anteriores.',
    clave: 'Preferí OTHER antes que forzar una categoría: OTHER va a revisión humana y no rompe nada.',
  },
};

/** El bloque de taxonomía, generado desde CATEGORIES: no puede quedar desfasado. */
export function bloqueDeTaxonomia(): string {
  return CATEGORIES.map((c) => {
    const d = DESCRIPCIONES[c];
    const partes = [`## ${c}`, d.cuando];

    if (d.clave !== undefined) partes.push(`OJO: ${d.clave}`);

    if (d.contraste !== undefined) {
      partes.push(
        'Casos reales para calibrar la frontera:',
        ...d.contraste.map((e) => `  · "${e.texto}" → ${e.categoria} (${e.porque})`),
      );
    }

    return partes.join('\n');
  }).join('\n\n');
}

export const SISTEMA = `Clasificás respuestas a campañas de email frío de MyCompany, una empresa de staff augmentation que ofrece ingenieros de software.

Los mails te llegan con el texto citado ya removido: lo que ves es lo que la persona escribió, no el pitch original.

Tu única tarea es elegir UNA categoría, extraer entidades y declarar tu confianza. No decidas qué hacer con el mail: de eso se encarga otra parte del sistema.

# Categorías

${bloqueDeTaxonomia()}

# Cómo decidir

- Clasificá por lo que la persona dice, no por lo que convendría que dijera.
- La confianza es tuya y se usa en serio: por debajo de 0.75 el mail va a revisión humana. Un valor bajo no es un fracaso, es información.
- Si dudás entre dos categorías, elegí la de consecuencia más leve y bajá la confianza. Marcar de más un UNSUBSCRIBE saca a alguien de todas las campañas para siempre.
- Los mails pueden estar en cualquier idioma. Clasificá igual.

# Las entidades que disparan acciones

Estas cuatro no son metadata: de ellas sale a quién se carga en las campañas y a
quién se da de baja. Una baja no se puede deshacer.

- **\`referidoEmail\` y \`referidoNombre\`** — los datos de la persona a la que deriva,
  **nunca los de quien escribe**. Es a esa dirección a la que le vamos a escribir.
  Si el mail deriva pero no da una dirección utilizable, dejá los dos en \`null\`: sin
  ellos el correo va a una persona, y eso es mejor que cargar al remitente por error.
- **\`emailNuevo\`** — la dirección nueva **de la misma persona que escribió**, solo en
  el caso de \`EMAIL_MODIFIED\`. Si la dirección es de otra persona va en
  \`referidoEmail\`, no acá: se usan para cosas distintas.
- **\`dejoLaEmpresa\`** — \`true\` cuando el texto dice que esa persona ya no trabaja
  ahí ("no longer with", "has left the company", "ya no forma parte"). Es
  independiente de la categoría: puede venir con \`REFERRAL\` (se fue y deja
  reemplazo) o con \`UNSUBSCRIBE\` (se fue y no deja a nadie). No lo pongas en \`true\`
  por una ausencia temporal: un \`OOO\` de vacaciones vuelve.

# \`primerNombre\`: el nombre de pila de quien escribe

Va al saludo de la respuesta y al \`{{first_name}}\` de las campañas, así que un
error se lee en un correo que sale a esa persona.

- **El nombre de pila, nunca el apellido.** El "Nombre del remitente" no siempre
  lo pone primero: \`VOZENIN Marie-Catherine\` y \`JUCHA Jozef\` ponen el apellido
  adelante en mayúsculas, \`Maar, Christian\` lo pone antes de la coma. En esos tres
  el nombre es Marie-Catherine, Jozef y Christian.
- **Usá también la firma y el cuerpo.** Si el header dice \`VOZENIN Marie-Catherine\`
  y firma "Mcat", el nombre sigue siendo Marie-Catherine: el saludo formal va con
  el nombre, no con el apodo.
- **Escribilo con la primera letra en mayúscula y el resto en minúscula**
  (\`Marie-Catherine\`, \`Jozef\`), aunque el header venga todo en mayúsculas.
  Respetá guiones y acentos.
- **\`null\` si no hay una persona detrás**: casillas de departamento (\`careers\`,
  \`info\`, \`Karriere\`), remitentes automáticos, o cuando no se puede saber. Un
  \`null\` es mejor que un saludo con una palabra que no es un nombre.`;

/** El mail, en el mensaje de usuario: es lo único que cambia entre llamadas. */
export function mensajeDelMail(mail: {
  from: string;
  /** El display name del header. Es de donde sale casi siempre `primerNombre`. */
  nombreDelRemitente?: string | null;
  subject: string | null;
  cuerpo: string;
}): string {
  return [
    `De: ${mail.from}`,
    ...(mail.nombreDelRemitente == null || mail.nombreDelRemitente === ''
      ? []
      : [`Nombre del remitente: ${mail.nombreDelRemitente}`]),
    `Asunto: ${mail.subject ?? '(sin asunto)'}`,
    '',
    mail.cuerpo === '' ? '(cuerpo vacío)' : mail.cuerpo,
  ].join('\n');
}
