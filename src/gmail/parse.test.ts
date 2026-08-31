import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodificarEncodedWords,
  htmlATexto,
  parsearListaDeDirecciones,
  parsearMensaje,
  parsearRemitente,
} from './parse.js';
import { mensajeSchema, type MensajeGmail } from './schemas.js';

const b64url = (s: string | Buffer): string =>
  (typeof s === 'string' ? Buffer.from(s, 'utf8') : s)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

function mensaje(payload: MensajeGmail['payload']): MensajeGmail {
  return mensajeSchema.parse({
    id: 'msg-1',
    threadId: 'thread-1',
    labelIds: ['INBOX'],
    internalDate: String(Date.UTC(2026, 7, 17, 12, 0, 0)),
    payload,
  });
}

describe('parsearMensaje', () => {
  it('prefiere text/plain cuando el mail trae las dos partes', () => {
    const m = parsearMensaje(
      mensaje({
        mimeType: 'multipart/alternative',
        headers: [{ name: 'From', value: 'Marcus Webb <marcus@acme.com>' }],
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('respuesta en texto plano') } },
          { mimeType: 'text/html', body: { data: b64url('<p>respuesta en html</p>') } },
        ],
      }),
    );

    assert.equal(m.formato, 'text/plain');
    assert.equal(m.cuerpo, 'respuesta en texto plano');
  });

  it('cae a text/html y le saca el blockquote del citado', () => {
    const html =
      '<div>No thanks, we are good.</div><blockquote>Hi Marcus, MyCompany helps you hire...</blockquote>';

    const m = parsearMensaje(
      mensaje({ mimeType: 'text/html', body: { data: b64url(html) } }),
    );

    assert.equal(m.formato, 'text/html');
    assert.equal(m.cuerpo, 'No thanks, we are good.');
  });

  it('decodifica quoted-printable', () => {
    const qp = 'Hola=2C no estamos buscando por ahora=2E Gracias =E2=80=94 Mart=C3=ADn';

    const m = parsearMensaje(
      mensaje({
        mimeType: 'text/plain',
        headers: [
          { name: 'Content-Type', value: 'text/plain; charset="utf-8"' },
          { name: 'Content-Transfer-Encoding', value: 'quoted-printable' },
        ],
        body: { data: b64url(qp) },
      }),
    );

    assert.equal(m.cuerpo, 'Hola, no estamos buscando por ahora. Gracias — Martín');
  });

  it('rearma las líneas partidas con soft break de quoted-printable', () => {
    const m = parsearMensaje(
      mensaje({
        mimeType: 'text/plain',
        headers: [{ name: 'Content-Transfer-Encoding', value: 'quoted-printable' }],
        body: { data: b64url('esta linea sigue =\nen la siguiente') },
      }),
    );

    assert.equal(m.cuerpo, 'esta linea sigue en la siguiente');
  });

  it('decodifica charset latin1', () => {
    const m = parsearMensaje(
      mensaje({
        mimeType: 'text/plain',
        headers: [{ name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' }],
        body: { data: b64url(Buffer.from('Mart\xEDn Gonz\xE1lez', 'latin1')) },
      }),
    );

    assert.equal(m.cuerpo, 'Martín González');
  });

  it('le cree a los bytes cuando el remitente miente sobre el charset', () => {
    // Caso real de la casilla: auto-respuesta holandesa que declara iso-8859-1
    // pero manda UTF-8. Sin esto, "€29,95" llega como "â¬29,95".
    const m = parsearMensaje(
      mensaje({
        mimeType: 'text/plain',
        headers: [{ name: 'Content-Type', value: 'text/plain; charset=iso-8859-1' }],
        body: { data: b64url(Buffer.from('Voor €29,95 geïnformeerd', 'utf8')) },
      }),
    );

    assert.equal(m.cuerpo, 'Voor €29,95 geïnformeerd');
  });

  it('pero respeta latin1 de verdad, que no es UTF-8 válido', () => {
    const m = parsearMensaje(
      mensaje({
        mimeType: 'text/plain',
        headers: [{ name: 'Content-Type', value: 'text/plain; charset=windows-1252' }],
        body: { data: b64url(Buffer.from('Precio: 29,95 \x80 para Mart\xEDn', 'latin1')) },
      }),
    );

    assert.match(m.cuerpo, /Martín/);
  });

  it('ignora los adjuntos', () => {
    const m = parsearMensaje(
      mensaje({
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('mirá el adjunto') } },
          {
            mimeType: 'text/plain',
            filename: 'contrato.txt',
            body: { data: b64url('CONTENIDO DEL ADJUNTO') },
          },
        ],
      }),
    );

    assert.equal(m.cuerpo, 'mirá el adjunto');
  });

  it('recorre multipart anidado', () => {
    const m = parsearMensaje(
      mensaje({
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [{ mimeType: 'text/plain', body: { data: b64url('texto anidado') } }],
          },
        ],
      }),
    );

    assert.equal(m.cuerpo, 'texto anidado');
  });

  it('limpia el citado del cuerpo pero conserva el crudo', () => {
    const m = parsearMensaje(
      mensaje({
        mimeType: 'text/plain',
        body: {
          data: b64url('No thanks.\n\nOn Mon, Aug 17, 2026 at 9:14 AM Ally <a@mycompany.co> wrote:\n> pitch'),
        },
      }),
    );

    assert.equal(m.cuerpo, 'No thanks.');
    assert.ok(m.cuerpoCrudo.includes('pitch'));
    assert.equal(m.limpieza.cortadoPor, 'on-wrote');
  });

  it('usa internalDate para la fecha', () => {
    const m = parsearMensaje(mensaje({ mimeType: 'text/plain', body: { data: b64url('hola') } }));
    assert.equal(m.date.toISOString(), '2026-08-17T12:00:00.000Z');
  });

  it('sobrevive a un mensaje sin payload', () => {
    const m = parsearMensaje(mensajeSchema.parse({ id: 'x', threadId: 'y' }));

    assert.equal(m.formato, 'ninguno');
    assert.equal(m.cuerpo, '');
    assert.equal(m.from.email, '');
  });
});

describe('To y Delivered-To', () => {
  it('guarda a qué alias de MyCompany llegó la respuesta', () => {
    const m = parsearMensaje(
      mensaje({
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Marcus <marcus@acme.com>' },
          { name: 'To', value: 'Ally Taylor <ally.j.taylor@mycompany.co>' },
          { name: 'Delivered-To', value: 'ally.taylor@mycompany.co' },
        ],
        body: { data: b64url('no thanks') },
      }),
    );

    assert.deepEqual(m.to.map((d) => d.email), ['ally.j.taylor@mycompany.co']);
    assert.deepEqual(m.deliveredTo, ['ally.taylor@mycompany.co']);
  });

  it('distingue alias con y sin punto: en este dominio son cuentas distintas', () => {
    const m = parsearMensaje(
      mensaje({
        mimeType: 'text/plain',
        headers: [{ name: 'To', value: 'allyjtaylor@mycompany.co' }],
        body: { data: b64url('x') },
      }),
    );

    assert.deepEqual(m.to.map((d) => d.email), ['allyjtaylor@mycompany.co']);
    assert.notDeepEqual(m.to.map((d) => d.email), ['ally.j.taylor@mycompany.co']);
  });

  it('junta los Delivered-To repetidos', () => {
    const m = parsearMensaje(
      mensaje({
        mimeType: 'text/plain',
        headers: [
          { name: 'Delivered-To', value: 'ally.taylor@mycompany.co' },
          { name: 'Delivered-To', value: 'allison.j.taylor@mycompany.co' },
        ],
        body: { data: b64url('x') },
      }),
    );

    assert.deepEqual(m.deliveredTo, ['ally.taylor@mycompany.co', 'allison.j.taylor@mycompany.co']);
  });

  it('sin To ni Delivered-To devuelve listas vacías, no null', () => {
    const m = parsearMensaje(mensaje({ mimeType: 'text/plain', body: { data: b64url('x') } }));

    assert.deepEqual(m.to, []);
    assert.deepEqual(m.deliveredTo, []);
  });
});

describe('In-Reply-To / References', () => {
  it('distingue el que abre el hilo del que responde adentro', () => {
    const abre = parsearMensaje(
      mensaje({ mimeType: 'text/plain', body: { data: b64url('pitch original') } }),
    );
    assert.equal(abre.enRespuestaA, null);
    assert.deepEqual(abre.referencias, []);

    const responde = parsearMensaje(
      mensaje({
        mimeType: 'text/plain',
        headers: [
          { name: 'In-Reply-To', value: '<abc@mail.gmail.com>' },
          { name: 'References', value: '<uno@x.com> <dos@y.com>' },
        ],
        body: { data: b64url('respuesta') },
      }),
    );
    assert.equal(responde.enRespuestaA, '<abc@mail.gmail.com>');
    assert.deepEqual(responde.referencias, ['<uno@x.com>', '<dos@y.com>']);
  });

  it('ignora basura en References que no sea un message-id', () => {
    const m = parsearMensaje(
      mensaje({
        mimeType: 'text/plain',
        headers: [{ name: 'References', value: 'no-es-un-id <si@lo.es>' }],
        body: { data: b64url('x') },
      }),
    );
    assert.deepEqual(m.referencias, ['<si@lo.es>']);
  });
});

describe('parsearListaDeDirecciones', () => {
  it('parte por comas', () => {
    assert.deepEqual(
      parsearListaDeDirecciones('a@acme.com, Ally <ally.j.taylor@mycompany.co>').map((d) => d.email),
      ['a@acme.com', 'ally.j.taylor@mycompany.co'],
    );
  });

  it('no se rompe con una coma adentro del nombre entre comillas', () => {
    const r = parsearListaDeDirecciones('"Taylor, Ally" <ally.j.taylor@mycompany.co>, b@acme.com');

    assert.deepEqual(r.map((d) => d.email), ['ally.j.taylor@mycompany.co', 'b@acme.com']);
    assert.equal(r[0]?.nombre, 'Taylor, Ally');
  });

  it('devuelve vacío para null o cadena vacía', () => {
    assert.deepEqual(parsearListaDeDirecciones(null), []);
    assert.deepEqual(parsearListaDeDirecciones('   '), []);
  });
});

describe('parsearRemitente', () => {
  it('separa nombre y mail', () => {
    assert.deepEqual(parsearRemitente('Marcus Webb <Marcus@Acme.com>'), {
      nombre: 'Marcus Webb',
      email: 'marcus@acme.com',
    });
  });

  it('acepta el mail pelado', () => {
    assert.deepEqual(parsearRemitente('marcus@acme.com'), { nombre: null, email: 'marcus@acme.com' });
  });

  it('saca las comillas del nombre y decodifica encoded words', () => {
    assert.deepEqual(parsearRemitente('"=?UTF-8?B?TWFydMOtbg==?=" <martin@acme.com>'), {
      nombre: 'Martín',
      email: 'martin@acme.com',
    });
  });

  it('detecta al mailer-daemon de los bounces', () => {
    assert.deepEqual(parsearRemitente('Mail Delivery Subsystem <mailer-daemon@amazonses.com>'), {
      nombre: 'Mail Delivery Subsystem',
      email: 'mailer-daemon@amazonses.com',
    });
  });
});

describe('decodificarEncodedWords', () => {
  it('decodifica base64 y quoted-printable', () => {
    assert.equal(decodificarEncodedWords('=?UTF-8?B?Tm8gZ3JhY2lhcw==?='), 'No gracias');
    assert.equal(decodificarEncodedWords('=?UTF-8?Q?No_est=C3=A1_disponible?='), 'No está disponible');
  });

  it('deja intacto lo que no está codificado', () => {
    const asunto = 'Contact from Allison Taylor @ MyCompany to Marcus';
    assert.equal(decodificarEncodedWords(asunto), asunto);
  });
});

describe('htmlATexto', () => {
  it('tira style y script, y convierte los saltos', () => {
    assert.equal(
      htmlATexto('<style>p{color:red}</style><p>uno</p><p>dos<br>tres</p>'),
      'uno\ndos\ntres',
    );
  });

  it('decodifica entidades', () => {
    assert.equal(htmlATexto('<p>Tom &amp; Jerry &lt;3 &#39;quotes&#39;</p>'), "Tom & Jerry <3 'quotes'");
  });

  it('saca el div de citado de Gmail', () => {
    assert.equal(
      htmlATexto('<div>respuesta</div><div class="gmail_quote">pitch citado</div>'),
      'respuesta',
    );
  });
});
