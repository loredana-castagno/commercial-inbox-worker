/**
 * Stripping del texto citado.
 *
 * Las respuestas a las campañas vienen con el pitch original de MyCompany pegado
 * abajo, y muchas veces la respuesta real son tres líneas. Si el citado se cuela,
 * el clasificador de la Fase 3 decide sobre el ruido en vez de sobre el contenido.
 *
 * Es heurístico y no va a ser perfecto. Por eso devuelve *qué* marcador cortó y
 * cuántas líneas se fueron: el objetivo no es acertar siempre, es que cuando falle
 * se pueda ver por qué (`npm run gmail:peek`).
 *
 * Limitación conocida: una respuesta intercalada dentro del citado (el clásico
 * "ver mis respuestas abajo en rojo") se pierde a partir del primer marcador. Es
 * poco frecuente en respuestas a campañas frías, pero existe.
 */

interface Marcador {
  nombre: string;
  patron: RegExp;
}

const MARCADORES: readonly Marcador[] = [
  {
    // "On Mon, Aug 18, 2026 at 10:03 AM Ally Taylor <ally@...> wrote:"
    // Puede venir cortado en dos líneas, por eso [\s\S] acotado.
    nombre: 'on-wrote',
    // El verbo no siempre queda pegado a los dos puntos: en inglés va al final
    // ("… Ally Taylor <a@b> wrote:"), pero en alemán y neerlandés va antes del
    // nombre ("Am 17.08.2026 schrieb Ally Taylor:"). Por eso se permite texto
    // entre el verbo y el `:`, acotado para no tragarse media línea de prosa.
    //
    // Sin `\b` después del verbo a propósito: en regex de JS sin flag `u`, la `ó`
    // de "escribió" no es carácter de palabra, así que `\b` ahí nunca matchea y
    // el caso español se rompe en silencio.
    patron:
      /^[ \t>]*(?:On|El|Am|Op|Em|Il|Den)\b[\s\S]{0,300}?(?:wrote|escribió|escribio|a écrit|schrieb|schreef|escreveu|ha scritto|skrev)[^\n:]{0,60}:[ \t]*$/m,
  },
  {
    nombre: 'original-message',
    patron:
      /^[ \t>]*-{2,}\s*(?:Original Message|Mensaje original|Forwarded message|Mensaje reenviado)\s*-{2,}[ \t]*$/im,
  },
  {
    // Bloque de headers de Outlook, multi-idioma: la etiqueta del remitente
    // seguida de al menos otro header. Exigir el segundo evita cortar en un
    // "From:" que sea prosa.
    //
    // Los idiomas salieron de medir la casilla: 9 de 91 mails llegaban al
    // clasificador con el pitch entero adentro porque el patrón cubría solo
    // inglés y español. Alemán (Von/Gesendet), neerlandés (Van/Verzonden) y
    // portugués (De/Enviada em) son los que aparecen en el volumen real.
    nombre: 'headers-outlook',
    patron:
      /^[ \t>]*(?:From|De|Von|Van|Da|Från|Fra):[ \t]*\S.*$\r?\n(?:[ \t>]*(?:Sent|Gesendet|Verzonden|Enviada em|Enviado el|Enviado|Envoyé|Inviato|Skickat|To|Para|An|Aan|À|Til|Cc|CC|Subject|Asunto|Betreff|Onderwerp|Objet|Oggetto|Ämne|Date|Datum|Fecha|Data):.*(?:\r?\n|$)){1,5}/im,
  },
  {
    // Separador de Outlook / Hotmail.
    nombre: 'separador-outlook',
    patron: /^[ \t>]*_{5,}[ \t]*$/m,
  },
  {
    nombre: 'separador-gmail',
    patron: /^[ \t>]*-{5,}\s*(?:Mensaje reenviado|Forwarded message)\s*-{5,}[ \t]*$/im,
  },
];

const FIRMAS_SUELTAS: readonly RegExp[] = [
  /^[ \t]*--[ \t]*$/m,
  /^[ \t]*(?:Sent from my (?:iPhone|iPad|Android|mobile|Samsung).*)$/im,
  /^[ \t]*(?:Enviado desde mi (?:iPhone|iPad|Android|móvil|movil).*)$/im,
  /^[ \t]*Get Outlook for (?:iOS|Android).*$/im,
  /^[ \t]*Obtener Outlook para (?:iOS|Android).*$/im,
];

export interface ResultadoDeLimpieza {
  texto: string;
  /** Nombre del marcador que cortó el citado, o null si no se encontró ninguno. */
  cortadoPor: string | null;
  firmaQuitada: boolean;
  lineasQuitadas: number;
}

function contarLineas(texto: string): number {
  if (texto === '') return 0;
  return texto.split('\n').length;
}

/** Saca el bloque final de líneas citadas con ">" y las vacías que lo rodean. */
function quitarCitadoFinal(texto: string): { texto: string; hubo: boolean } {
  const lineas = texto.split('\n');
  let fin = lineas.length;
  let hubo = false;

  while (fin > 0) {
    const linea = lineas[fin - 1] ?? '';
    if (/^[ \t]*>/.test(linea)) {
      hubo = true;
      fin -= 1;
      continue;
    }
    if (linea.trim() === '' && hubo) {
      fin -= 1;
      continue;
    }
    break;
  }

  return { texto: lineas.slice(0, fin).join('\n'), hubo };
}

function quitarFirma(texto: string): { texto: string; hubo: boolean } {
  let corte = texto.length;

  for (const patron of FIRMAS_SUELTAS) {
    const match = patron.exec(texto);
    if (match && match.index < corte) corte = match.index;
  }

  if (corte === texto.length) return { texto, hubo: false };
  return { texto: texto.slice(0, corte), hubo: true };
}

export function limpiarCitado(cuerpo: string): ResultadoDeLimpieza {
  const original = cuerpo.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lineasOriginales = contarLineas(original);

  let corte = original.length;
  let cortadoPor: string | null = null;

  for (const { nombre, patron } of MARCADORES) {
    const match = patron.exec(original);
    if (match && match.index < corte) {
      corte = match.index;
      cortadoPor = nombre;
    }
  }

  let texto = original.slice(0, corte);

  const sinCitado = quitarCitadoFinal(texto);
  texto = sinCitado.texto;
  if (cortadoPor === null && sinCitado.hubo) cortadoPor = 'lineas-citadas';

  const sinFirma = quitarFirma(texto);
  texto = sinFirma.texto;

  // Tres o más saltos seguidos no aportan nada al clasificador.
  texto = texto.replace(/\n{3,}/g, '\n\n').trim();

  return {
    texto,
    cortadoPor,
    firmaQuitada: sinFirma.hubo,
    lineasQuitadas: Math.max(0, lineasOriginales - contarLineas(texto)),
  };
}
