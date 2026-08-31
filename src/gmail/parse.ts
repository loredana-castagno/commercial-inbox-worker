import { limpiarCitado, type ResultadoDeLimpieza } from './strip-quoted.js';
import type { MensajeGmail, PayloadGmail } from './schemas.js';

export interface Remitente {
  nombre: string | null;
  email: string;
}

export interface MensajeParseado {
  messageId: string;
  threadId: string;
  /**
   * El `Message-ID` de RFC 5322 del propio mensaje, con sus `<>`.
   *
   * No confundir con `messageId`, que es el id **de Gmail**. Éste es el
   * identificador que viaja en las cabeceras y el que hay que poner en el
   * `In-Reply-To` de una respuesta para que los clientes la enhebren.
   */
  messageIdRfc822: string | null;
  from: Remitente;
  /**
   * A qué alias de MyCompany llegó la respuesta.
   *
   * **No sirve como señal de campaña**: la relación es de muchas campañas a un
   * alias, así que del `To:` no se puede derivar de cuál vino la respuesta — eso
   * sale exclusivamente de la consulta a Snov (`campañaOrigen` en SPEC.md).
   *
   * Sirve para otra cosa: ver qué alias están recibiendo tráfico, que es el dato
   * con el que se arma la lista de direcciones propias de la Fase 4.
   */
  to: Remitente[];
  deliveredTo: string[];
  /**
   * `In-Reply-To` / `References`. Vacío = el mensaje **abre** el hilo.
   *
   * Distingue el envío original de campaña de una respuesta dentro del hilo, que
   * desde afuera se ven igual: los dos salen de una dirección de MyCompany. Sin
   * esto, minar el criterio de Ally a partir de sus respuestas devuelve las
   * plantillas de la campaña, que no son un criterio de clasificación.
   *
   * Es también la guarda 2 de `NO_ES_RESPUESTA` (SPEC.md § 12): un hilo con un
   * mensaje previo nuestro no es un newsletter aunque lo parezca.
   */
  enRespuestaA: string | null;
  referencias: string[];
  subject: string | null;
  date: Date;
  labelIds: string[];
  /** De qué parte MIME salió el cuerpo. text/plain gana cuando existen las dos. */
  formato: 'text/plain' | 'text/html' | 'ninguno';
  /** Cuerpo tal como vino, decodificado pero sin limpiar. Sirve para comparar. */
  cuerpoCrudo: string;
  /** Cuerpo sin citado ni firma: es lo que ve el clasificador. */
  cuerpo: string;
  limpieza: ResultadoDeLimpieza;
}

function decodificarBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Quoted-printable. Gmail devuelve `body.data` en base64url del contenido *crudo*
 * de la parte: si el mail venía en quoted-printable, después de desarmar el base64
 * siguen estando los `=E2=80=99` y los `=` de fin de línea.
 */
function decodificarQuotedPrintable(texto: string): Buffer {
  const sinSoftBreaks = texto.replace(/=(?:\r\n|\n|\r)/g, '');
  const bytes: number[] = [];

  for (let i = 0; i < sinSoftBreaks.length; i += 1) {
    const char = sinSoftBreaks[i] ?? '';
    if (char === '=' && i + 2 < sinSoftBreaks.length) {
      const hex = sinSoftBreaks.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(char.charCodeAt(0) & 0xff);
  }

  return Buffer.from(bytes);
}

/** Charsets de un byte donde un `Ã©` delata que el contenido era UTF-8. */
const SINGLE_BYTE = /^(iso-8859-\d+|windows-125\d|latin\d?|ascii|us-ascii|cp125\d)$/;

/** ¿Los bytes son UTF-8 multibyte válido? Por accidente casi nunca lo son. */
function pareceUtf8(bytes: Buffer): boolean {
  if (!bytes.some((b) => b >= 0x80)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function decodificarCharset(bytes: Buffer, charset: string | null): string {
  const normalizado = (charset ?? 'utf-8').toLowerCase().replace(/["']/g, '').trim();

  // Hay remitentes que declaran iso-8859-1 y mandan UTF-8. Visto en la casilla:
  // una auto-respuesta holandesa donde "€29,95" llegaba como "â¬29,95". Si el
  // charset declarado es de un byte pero los bytes decodifican como UTF-8
  // válido, le creemos a los bytes y no al header.
  if (SINGLE_BYTE.test(normalizado) && pareceUtf8(bytes)) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  try {
    return new TextDecoder(normalizado).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

function leerHeader(payload: PayloadGmail | null | undefined, nombre: string): string | null {
  const header = (payload?.headers ?? []).find(
    (h) => h.name.toLowerCase() === nombre.toLowerCase(),
  );
  return header?.value ?? null;
}

/** `Delivered-To` puede venir repetido: Gmail agrega uno por salto de entrega. */
function leerHeaders(payload: PayloadGmail | null | undefined, nombre: string): string[] {
  return (payload?.headers ?? [])
    .filter((h) => h.name.toLowerCase() === nombre.toLowerCase())
    .map((h) => h.value ?? '')
    .filter((v) => v.trim() !== '');
}

function charsetDe(payload: PayloadGmail): string | null {
  const contentType = leerHeader(payload, 'content-type');
  const match = contentType === null ? null : /charset=([^;]+)/i.exec(contentType);
  return match?.[1]?.trim() ?? null;
}

function decodificarParte(payload: PayloadGmail): string {
  const data = payload.body?.data;
  if (data === null || data === undefined || data === '') return '';

  const bytes = decodificarBase64Url(data);
  const encoding = (leerHeader(payload, 'content-transfer-encoding') ?? '').toLowerCase().trim();

  const finales =
    encoding === 'quoted-printable'
      ? decodificarQuotedPrintable(bytes.toString('latin1'))
      : bytes;

  return decodificarCharset(finales, charsetDe(payload));
}

/** RFC 2047: "=?UTF-8?B?...?=" en Subject y From. Sin esto los acentos vuelan. */
export function decodificarEncodedWords(valor: string): string {
  return valor.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (completo, charset: string, tipo: string, contenido: string) => {
      try {
        const bytes =
          tipo.toUpperCase() === 'B'
            ? Buffer.from(contenido, 'base64')
            : decodificarQuotedPrintable(contenido.replace(/_/g, ' '));
        return decodificarCharset(bytes, charset);
      } catch {
        return completo;
      }
    },
  );
}

export function parsearRemitente(valor: string | null): Remitente {
  if (valor === null || valor.trim() === '') return { nombre: null, email: '' };

  const decodificado = decodificarEncodedWords(valor).trim();
  const conAngulos = /^(.*)<([^>]+)>\s*$/.exec(decodificado);

  if (conAngulos) {
    const nombre = (conAngulos[1] ?? '').trim().replace(/^["']|["']$/g, '');
    return {
      nombre: nombre === '' ? null : nombre,
      email: (conAngulos[2] ?? '').trim().toLowerCase(),
    };
  }

  return { nombre: null, email: decodificado.toLowerCase() };
}

/**
 * Parte una lista de direcciones por comas, respetando las comas que están adentro
 * de comillas (`"Taylor, Ally" <a@mycompany.co>`) o de los ángulos.
 */
export function parsearListaDeDirecciones(valor: string | null): Remitente[] {
  if (valor === null || valor.trim() === '') return [];

  const partes: string[] = [];
  let actual = '';
  let enComillas = false;
  let enAngulos = false;

  for (const char of valor) {
    if (char === '"') enComillas = !enComillas;
    else if (char === '<') enAngulos = true;
    else if (char === '>') enAngulos = false;

    if (char === ',' && !enComillas && !enAngulos) {
      partes.push(actual);
      actual = '';
      continue;
    }
    actual += char;
  }
  partes.push(actual);

  return partes
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => parsearRemitente(p))
    .filter((r) => r.email !== '');
}

const ENTIDADES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
};

function decodificarEntidades(html: string): string {
  return html
    .replace(/&#(\d+);/g, (_, num: string) => String.fromCodePoint(Number(num)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&([a-z0-9#]+);/gi, (completo, nombre: string) => ENTIDADES[nombre.toLowerCase()] ?? completo);
}

/**
 * HTML a texto. Los `blockquote` y los `div.gmail_quote` se tiran enteros: es
 * donde Gmail y Outlook meten el citado, así que sacarlos acá es más confiable
 * que buscar marcadores después.
 */
export function htmlATexto(html: string): string {
  const sinCitado = html
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*id="[^"]*(?:divRplyFwdMsg|appendonsend)[^"]*"[\s\S]*/gi, '');

  return decodificarEntidades(
    sinCitado
      .replace(/<(?:style|script|head)[\s\S]*?<\/(?:style|script|head)>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface ParteElegida {
  texto: string;
  formato: 'text/plain' | 'text/html' | 'ninguno';
}

/** Recorre el árbol MIME y junta las partes de texto, ignorando adjuntos. */
function elegirCuerpo(payload: PayloadGmail | null | undefined): ParteElegida {
  const planas: string[] = [];
  const htmls: string[] = [];

  const recorrer = (parte: PayloadGmail): void => {
    const mime = (parte.mimeType ?? '').toLowerCase();
    const esAdjunto = (parte.filename ?? '') !== '';

    if (!esAdjunto && mime === 'text/plain') planas.push(decodificarParte(parte));
    else if (!esAdjunto && mime === 'text/html') htmls.push(decodificarParte(parte));

    for (const hija of parte.parts ?? []) recorrer(hija);
  };

  if (payload) recorrer(payload);

  const plano = planas.join('\n').trim();
  if (plano !== '') return { texto: plano, formato: 'text/plain' };

  const html = htmls.join('\n').trim();
  if (html !== '') return { texto: htmlATexto(html), formato: 'text/html' };

  return { texto: '', formato: 'ninguno' };
}

export function parsearMensaje(mensaje: MensajeGmail): MensajeParseado {
  const payload = mensaje.payload ?? null;
  const { texto, formato } = elegirCuerpo(payload);
  const limpieza = limpiarCitado(texto);

  const subjectCrudo = leerHeader(payload, 'subject');
  const fechaHeader = leerHeader(payload, 'date');

  const internal = mensaje.internalDate;
  const date =
    internal !== null && internal !== undefined && internal !== ''
      ? new Date(Number(internal))
      : new Date(fechaHeader ?? Date.now());

  return {
    messageId: mensaje.id,
    threadId: mensaje.threadId,
    messageIdRfc822: leerHeader(payload, 'message-id'),
    from: parsearRemitente(leerHeader(payload, 'from')),
    to: parsearListaDeDirecciones(leerHeader(payload, 'to')),
    deliveredTo: leerHeaders(payload, 'delivered-to').map((v) =>
      parsearRemitente(v).email,
    ),
    enRespuestaA: leerHeader(payload, 'in-reply-to'),
    referencias: (leerHeader(payload, 'references') ?? '')
      .split(/\s+/)
      .filter((r) => r.startsWith('<')),
    subject: subjectCrudo === null ? null : decodificarEncodedWords(subjectCrudo),
    date,
    labelIds: mensaje.labelIds ?? [],
    formato,
    cuerpoCrudo: texto,
    cuerpo: limpieza.texto,
    limpieza,
  };
}
