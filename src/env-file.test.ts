import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { leerVariable, reemplazarVariable } from './env-file.js';

const ENV = [
  '# ---------------------------------------------------------------------------',
  '# GMAIL API',
  '# ---------------------------------------------------------------------------',
  'GMAIL_USER_EMAIL=ally.taylor@mycompany.co',
  '',
  '# Se obtiene una vez con `npm run auth:gmail`.',
  'GMAIL_REFRESH_TOKEN=1//viejo',
  '',
  'GMAIL_SCOPE=https://www.googleapis.com/auth/gmail.readonly',
  '',
].join('\n');

describe('reemplazarVariable', () => {
  it('reemplaza solo esa línea y deja el resto intacto', () => {
    const nuevo = reemplazarVariable(ENV, 'GMAIL_REFRESH_TOKEN', '1//nuevo');

    assert.equal(leerVariable(nuevo, 'GMAIL_REFRESH_TOKEN'), '1//nuevo');
    assert.equal(leerVariable(nuevo, 'GMAIL_USER_EMAIL'), 'ally.taylor@mycompany.co');
    assert.equal(
      leerVariable(nuevo, 'GMAIL_SCOPE'),
      'https://www.googleapis.com/auth/gmail.readonly',
    );
    assert.equal(nuevo.split('\n').length, ENV.split('\n').length, 'no cambia la cantidad de líneas');
    assert.ok(nuevo.includes('# GMAIL API'), 'conserva los comentarios');
  });

  it('no toca un comentario que menciona la clave', () => {
    const conComentario = '# GMAIL_REFRESH_TOKEN=poné acá el token\nGMAIL_REFRESH_TOKEN=1//viejo\n';
    const nuevo = reemplazarVariable(conComentario, 'GMAIL_REFRESH_TOKEN', '1//nuevo');

    assert.ok(nuevo.includes('# GMAIL_REFRESH_TOKEN=poné acá el token'));
    assert.equal(leerVariable(nuevo, 'GMAIL_REFRESH_TOKEN'), '1//nuevo');
  });

  it('agrega la clave si no existe, sin romper el final del archivo', () => {
    const nuevo = reemplazarVariable('OTRA=1\n', 'GMAIL_REFRESH_TOKEN', '1//nuevo');

    assert.equal(leerVariable(nuevo, 'GMAIL_REFRESH_TOKEN'), '1//nuevo');
    assert.equal(leerVariable(nuevo, 'OTRA'), '1');
    assert.ok(nuevo.endsWith('\n'), 'mantiene el salto final');
  });

  it('conserva CRLF si el archivo venía con CRLF', () => {
    const crlf = 'A=1\r\nGMAIL_REFRESH_TOKEN=viejo\r\nB=2\r\n';
    const nuevo = reemplazarVariable(crlf, 'GMAIL_REFRESH_TOKEN', 'nuevo');

    assert.ok(nuevo.includes('\r\n'), 'sigue con CRLF');
    assert.ok(!/[^\r]\n/.test(nuevo), 'no mezcla LF suelto con CRLF');
    assert.equal(leerVariable(nuevo, 'B'), '2');
  });

  it('reemplaza una sola vez aunque la clave esté repetida', () => {
    const repetida = 'GMAIL_REFRESH_TOKEN=a\nGMAIL_REFRESH_TOKEN=b\n';
    const nuevo = reemplazarVariable(repetida, 'GMAIL_REFRESH_TOKEN', 'c');

    assert.equal(nuevo, 'GMAIL_REFRESH_TOKEN=c\nGMAIL_REFRESH_TOKEN=b\n');
  });

  it('tolera espacios alrededor del igual', () => {
    const conEspacios = 'GMAIL_REFRESH_TOKEN = viejo\n';
    assert.equal(leerVariable(reemplazarVariable(conEspacios, 'GMAIL_REFRESH_TOKEN', 'x'), 'GMAIL_REFRESH_TOKEN'), 'x');
  });
});
