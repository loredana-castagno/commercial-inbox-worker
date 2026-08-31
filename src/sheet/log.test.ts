import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ResultadoDeEjecucion } from '../execute/executor.js';
import {
  SheetLogger,
  filaDeCorrida,
  filaDeMail,
  formatearGmtMenos3,
  type MailRegistrado,
} from './log.js';

const AHORA = new Date('2026-08-23T10:00:00.000Z');

const RESULTADO: ResultadoDeEjecucion = {
  categoriaFinal: 'NO_THANKS',
  categoriaBase: null,
  necesitaRevision: false,
  resumen: 'NO_THANKS — 1 ejecutadas, 1 planeadas',
  resultados: [
    {
      accion: { tipo: 'ETIQUETAR', etiqueta: 'NO_THANKS' },
      estado: 'ejecutada',
      motivo: '',
      descripcion: 'etiquetar "NO_THANKS"',
    },
    {
      accion: { tipo: 'SUBIR_A_LISTA_SNOV', listaId: '1', nombreDeLista: 'No thanks' },
      estado: 'planeada',
      motivo: 'EXTERNAL_WRITE_ENABLED=false',
      descripcion: 'subir a la lista "No thanks" de Snov',
    },
  ],
};

const MAIL: MailRegistrado = {
  messageId: 'abc123',
  fecha: new Date('2026-08-22T18:30:00.000Z'),
  from: 'lead@empresa.com',
  nombre: 'Una Persona',
  asunto: 'Re: quick question',
  cuerpo: 'No gracias,\n\nno estamos buscando.',
  confianza: 0.91,
  clasificoPor: 'claude-opus-5',
  resultado: RESULTADO,
  motivosDeRevision: [],
};

const SHADOW = { gmailWriteEnabled: false, externalWriteEnabled: false };

describe('formatearGmtMenos3', () => {
  it('resta 3 horas y corta los segundos', () => {
    assert.equal(formatearGmtMenos3(new Date('2026-08-23T10:00:00.000Z')), '2026-08-23 07:00 (GMT -3)');
  });

  it('cruza la medianoche hacia el día anterior', () => {
    // 2026-08-23T02:00Z - 3h = 2026-08-22T23:00, no 2026-08-23T-01:00.
    assert.equal(formatearGmtMenos3(new Date('2026-08-23T02:00:00.000Z')), '2026-08-22 23:00 (GMT -3)');
  });

  it('cruza fin de mes y de año', () => {
    assert.equal(formatearGmtMenos3(new Date('2026-01-01T01:30:00.000Z')), '2025-12-31 22:30 (GMT -3)');
  });
});

describe('la fila de un mail', () => {
  it('lleva la hora de procesado y la del mail en GMT -3, no en UTC', () => {
    const f = filaDeMail(MAIL, SHADOW, AHORA);
    // AHORA es 2026-08-23T10:00Z, MAIL.fecha es 2026-08-22T18:30Z.
    assert.equal(f[0], '2026-08-23 07:00 (GMT -3)');
    assert.equal(f[1], '2026-08-22 15:30 (GMT -3)');
  });

  it('separa lo que hizo de lo que no, con el motivo', () => {
    const f = filaDeMail(MAIL, SHADOW, AHORA);
    assert.equal(f[10], 'etiquetar "NO_THANKS"');
    assert.equal(f[11], 'subir a la lista "No thanks" de Snov → EXTERNAL_WRITE_ENABLED=false');
  });

  it('aplana el cuerpo a una línea', () => {
    // Sheets no muestra los saltos y desalinea la columna.
    assert.equal(filaDeMail(MAIL, SHADOW, AHORA)[5], 'No gracias, no estamos buscando.');
  });

  it('trunca sin cortar la fila', () => {
    const largo = { ...MAIL, cuerpo: 'x'.repeat(900) };
    const extracto = filaDeMail(largo, SHADOW, AHORA)[5] ?? '';
    assert.equal(extracto.length, 500);
    assert.ok(extracto.endsWith('…'));
  });

  it('deja un guion y no una celda vacía cuando no hubo nada', () => {
    // Una celda vacía se lee como "no se registró"; un guion, como "no hubo".
    const sinAcciones = { ...MAIL, resultado: { ...RESULTADO, resultados: [] } };
    const f = filaDeMail(sinAcciones, SHADOW, AHORA);
    assert.equal(f[10], '—');
    assert.equal(f[11], '—');
  });

  it('una acción fallida no desaparece del log', () => {
    const conFalla = {
      ...MAIL,
      resultado: {
        ...RESULTADO,
        resultados: [
          {
            accion: { tipo: 'ETIQUETAR', etiqueta: 'NO_THANKS' } as const,
            estado: 'fallida' as const,
            motivo: 'HTTP 500 en modify',
            descripcion: 'etiquetar "NO_THANKS"',
          },
        ],
      },
    };
    const f = filaDeMail(conFalla, SHADOW, AHORA);
    assert.equal(f[10], '—', 'no hizo nada');
    assert.match(f[11] ?? '', /^FALLÓ: etiquetar "NO_THANKS" → HTTP 500/);
  });

  it('el modo dice qué barreras estaban puestas', () => {
    assert.equal(filaDeMail(MAIL, SHADOW, AHORA)[14], 'shadow (no escribe)');
    assert.equal(
      filaDeMail(MAIL, { gmailWriteEnabled: true, externalWriteEnabled: false }, AHORA)[14],
      'solo Gmail',
    );
    assert.equal(
      filaDeMail(MAIL, { gmailWriteEnabled: true, externalWriteEnabled: true }, AHORA)[14],
      'escritura completa',
    );
  });

  it('el link abre el mail en Gmail', () => {
    assert.equal(filaDeMail(MAIL, SHADOW, AHORA)[15], 'https://mail.google.com/mail/u/0/#all/abc123');
  });

  it('un asunto que empieza con = sigue siendo texto', () => {
    // El cliente manda valueInputOption RAW; esto documenta por qué importa.
    const f = filaDeMail({ ...MAIL, asunto: '=1+1 descuento' }, SHADOW, AHORA);
    assert.equal(f[4], '=1+1 descuento');
  });
});

describe('la fila de una corrida', () => {
  it('reporta los contadores como texto', () => {
    const f = filaDeCorrida(
      {
        via: 'historial',
        vistos: 50,
        calentamiento: 49,
        salientes: 0,
        yaProcesados: 0,
        clasificados: 1,
        aRevision: 1,
        ejecutadas: 0,
      },
      SHADOW,
      AHORA,
    );
    assert.deepEqual(f.slice(2, 9), ['50', '49', '0', '0', '1', '1', '0']);
    assert.equal(f[0], '2026-08-23 07:00 (GMT -3)');
  });
});

describe('un fallo del Sheet no puede frenar el worker', () => {
  it('registrarMail traga el error y sigue', async () => {
    const roto = {
      agregarFilas: async () => {
        throw new Error('503 backend error');
      },
    };
    const logger = new SheetLogger(
      roto as never,
      SHADOW,
      () => AHORA,
    );

    // Si esto tirara, un Sheets caído dejaría mails sin procesar.
    await logger.registrarMail(MAIL);
    await logger.registrarCorrida({
      via: 'historial',
      vistos: 1,
      calentamiento: 0,
      salientes: 0,
      yaProcesados: 0,
      clasificados: 1,
      aRevision: 0,
      ejecutadas: 0,
    });
  });

  it('preparar tampoco tira', async () => {
    const roto = {
      pestañas: async () => {
        throw new Error('403 sin permiso');
      },
    };
    await new SheetLogger(roto as never, SHADOW, () => AHORA).preparar();
  });
});
