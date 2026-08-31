/**
 * Los textos de los drafts, tal como los escribe Ally.
 *
 * **No los redactó este proyecto.** Son transcripción literal de los que ella usa
 * a mano, y por eso viven en un módulo aparte y no dentro de un handler: cambiar
 * la redacción es decisión de ella, no un cambio de código.
 *
 * Todos se generan como **draft dentro del hilo original** y ninguno se envía.
 * No existe en este repo un método que mande un mail (CLAUDE.md #5).
 *
 * La firma **no va acá**: Gmail la agrega sola al abrir el draft. Incluirla la
 * duplicaría.
 */

/**
 * Lo que Ally escribe cuando no tiene el dato: deja `XXX` visible y lo completa
 * al revisar. Se respeta esa convención en vez de inventar un relleno —un
 * "Hi there" tapa el hueco y hace más probable que se mande sin corregir.
 */
export const SIN_DATO = 'XXX';

export type NombreDePlantilla = 'Cold last try' | 'Ask for referral' | 'Position details HOT';

export interface VariablesDePlantilla {
  /** Solo el primer nombre del lead. */
  readonly nombre?: string | undefined;
  /** La tecnología o rol que pide el prospect. Solo la usa la de HOT. */
  readonly tecnologia?: string | undefined;
}

const PLANTILLAS: Record<NombreDePlantilla, string> = {
  // NOT_NOW — el último intento antes de dejarlo en el drip.
  //
  // La presentación va como link y no como adjunto: un PDF repetido en cada draft
  // engorda la casilla, y un link se actualiza sin volver a tocar el bot.
  'Cold last try': `Hi {{nombre}},

Many thanks for your response.

I understand you might not be looking for an outsourcing or IT staff augmentation solution at the moment. However, being in a market where things can change overnight, you know how tough it can be to find the right team in record time, and that's where we can offer our support when you need it.

You can find our presentation with more information about the solutions we offer here: https://mycompany.co/brochure/MyCompany_Presentation.pdf

I'll get in touch in a few months to check for new opportunities. If something comes up earlier then please feel free to reach out.

Regards,

Ally`,

  // NOT_RIGHT_CONTACT — dijo que no decide él, y no dio un nombre alternativo.
  'Ask for referral': `Hi {{nombre}},

Thanks for letting me know.

Would you mind me asking you to connect me to the person who is in charge of the role?

Thanks for your help,

Ally`,

  // HOT — interés comercial real. El draft pide los datos para armar la propuesta.
  'Position details HOT': `Hi {{nombre}},

Hope you are well, thanks for reaching out.

We do have experienced {{tecnologia}} developers on our team, but in order to narrow things down and find the right fit it would be great to have a little more information:

* Type of assignment (part or full-time)
* Length of assignment (months)
* Location (remote/on-site): Are you looking for onsite/hybrid resources, if so where do they need to be based? If you need remote workers, please advise if there is any limitation as to where they should be based, and if you would like to consider nearshore/offshore resources that could work in the necessary timezone. We can offer you both options.
* Complete required skillset. If you have a JD, please share it.
* Is there a budget we should stick to?
* Estimated start date

With those details, we will be able to present some professionals in a couple of days for you to have a look over.
If you would like to set up a brief call to talk further about our services, please let me know your availability and I'll set something up.

Looking forward to hearing from you soon.

Regards,

Ally`,
};

export function esNombreDePlantilla(valor: string): valor is NombreDePlantilla {
  return Object.hasOwn(PLANTILLAS, valor);
}

/**
 * El primer nombre del lead, sacado del display name del remitente.
 *
 * Los formatos reales de la casilla, relevados sobre los 62 nombres distintos del
 * dataset, no son solo "Nombre Apellido":
 *
 * | Formato | Ejemplo | Primer nombre |
 * |---|---|---|
 * | normal | `Kyle Anzalone` | Kyle |
 * | apellido primero, con coma | `Maar, Christian` | **Christian** |
 * | apellido primero, en mayúsculas | `VOZENIN Marie-Catherine` | **Marie-Catherine** |
 * | apellido último, en mayúsculas | `Michael BLANK` | Michael |
 * | con empresa | `Jan de Vries \| PlantCo` | Jan |
 * | con sufijo | `Gibbons, Bruce (BCIT)` | **Bruce** |
 *
 * Los dos que importan son los que ponen el apellido primero, porque partir por
 * espacios sin mirarlos saluda con el apellido:
 *
 * - **La coma** la usa Outlook corporativo y es frecuente en la casilla.
 * - **Las mayúsculas** son convención francesa, suiza y de varios países del este
 *   (`VOZENIN Marie-Catherine`, `JUCHA Jozef`). Se detectó tarde: un `EMAIL_MODIFIED`
 *   real subió a Snov un prospect con `firstName: "VOZENIN"`, y como las campañas
 *   saludan con `{{first_name}}`, la habría tratado por el apellido en mayúsculas.
 *
 * La regla de las mayúsculas es **un solo token en mayúsculas = ése es el
 * apellido**, y sirve en las dos direcciones. Con todos los tokens en mayúsculas
 * (`JOHN SMITH`) no hay señal y se toma el primero, como antes.
 *
 * **Limitación conocida:** una casilla de departamento (`Karriere`, `careers`)
 * devuelve esa palabra como si fuera un nombre. La revisión humana del draft es lo
 * que lo atrapa; no hay señal para distinguirlo desde acá.
 */

/** Un token que es todo mayúsculas y tiene al menos dos letras: un apellido. */
function esApellidoEnMayusculas(token: string): boolean {
  const letras = token.replace(/[^\p{L}]/gu, '');
  return (
    letras.length >= 2 &&
    letras === letras.toUpperCase() &&
    letras !== letras.toLowerCase() // descarta lo que no tiene may/min, como números
  );
}

/**
 * Deja el nombre en "Primera en mayúscula, el resto en minúscula".
 *
 * Va con el nombre a Snov y a los saludos de los drafts: `MARIE-CATHERINE` en un
 * "Hi ..." grita, y `jozef` se lee descuidado. Los dos llegan así desde headers
 * reales de la casilla.
 *
 * **Solo toca lo que está todo en mayúsculas o todo en minúsculas.** Un nombre que
 * ya viene con mayúsculas intercaladas —`McDonald`, `O'Brien`, `van Nood`— lo
 * escribió alguien a propósito y normalizarlo lo empeoraría (`Mcdonald`).
 *
 * Los separadores internos cuentan: `MARIE-CATHERINE` → `Marie-Catherine`.
 */
export function normalizarNombre(nombre: string): string {
  const letras = nombre.replace(/[^\p{L}]/gu, '');
  const todoIgual = letras === letras.toUpperCase() || letras === letras.toLowerCase();
  if (letras === '' || !todoIgual) return nombre;

  return nombre
    .toLowerCase()
    .replace(/(^|[-'’\s])(\p{L})/gu, (_, sep: string, letra: string) => sep + letra.toUpperCase());
}

export function primerNombre(displayName: string | null): string | undefined {
  if (displayName === null) return undefined;

  const limpio = displayName
    .replace(/\|.*$/, '') // "Jan de Vries | PlantCo"
    .replace(/\([^)]*\)/g, '') // "Kyle Anzalone (Leaver)"
    .replace(/["']/g, '')
    .trim();

  // "Apellido, Nombre": el nombre está después de la coma.
  const trasComa = limpio.includes(',') ? (limpio.split(',')[1] ?? '') : limpio;

  const tokens = trasComa.trim().split(/\s+/).filter((t) => t !== '');

  // "VOZENIN Marie-Catherine" / "Michael BLANK": si hay exactamente uno en
  // mayúsculas, ése es el apellido y se descarta, esté antes o después.
  const enMayusculas = tokens.filter(esApellidoEnMayusculas);
  const candidatos =
    tokens.length >= 2 && enMayusculas.length === 1
      ? tokens.filter((t) => !esApellidoEnMayusculas(t))
      : tokens;

  const token = candidatos[0] ?? '';

  // Una dirección de mail o algo sin letras no es un nombre.
  if (token === '' || token.includes('@') || !/\p{L}/u.test(token)) return undefined;

  return normalizarNombre(token);
}

/**
 * Reemplaza las variables. Las que no se pudieron resolver quedan como `XXX`, que
 * es lo que Ally deja cuando le falta el dato.
 */
export function renderizar(
  plantilla: NombreDePlantilla,
  variables: VariablesDePlantilla = {},
): string {
  const valores: Record<string, string> = {
    nombre: variables.nombre ?? SIN_DATO,
    tecnologia: variables.tecnologia ?? SIN_DATO,
  };

  return PLANTILLAS[plantilla].replace(/\{\{(\w+)\}\}/g, (original, clave: string) => {
    const valor = valores[clave];
    // Una variable que la plantilla usa y el código no conoce queda visible en vez
    // de desaparecer: un hueco silencioso en un mail a un prospect es peor.
    return valor ?? original;
  });
}

/**
 * El asunto del draft. **Siempre `Re:` del original**, nunca uno nuevo: el draft
 * es una respuesta dentro del hilo.
 */
export function asuntoDeRespuesta(asuntoOriginal: string | null): string {
  const base = (asuntoOriginal ?? '').trim();
  if (base === '') return 'Re:';
  return /^re\s*:/i.test(base) ? base : `Re: ${base}`;
}
