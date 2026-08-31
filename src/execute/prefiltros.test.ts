import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { carpetaQueBloquea, esAsuntoDeCalentamiento, prefiltrar } from './prefiltros.js';

const PROPIOS = ['mycompany.co', 'mycompany.com', 'mycompany.net'];

function sobre(email: string, subject: string) {
  return { from: { email }, subject };
}

describe('marcador de calentamiento', () => {
  it('reconoce el prefijo [WRM] tal como llega', () => {
    // Asuntos textuales de la corrida contra la casilla real.
    for (const s of [
      '[WRM] refilled soap dispenser workaround',
      '[WRM] Administrative hold: API synchronization error',
      '[wrm] minúsculas por las dudas',
    ]) {
      assert.equal(esAsuntoDeCalentamiento(s), true, s);
    }
  });

  it('atraviesa las cadenas de Re: y Fwd:, porque el calentamiento se responde solo', () => {
    assert.equal(esAsuntoDeCalentamiento('Re: [WRM] a mystery in the lobby'), true);
    assert.equal(esAsuntoDeCalentamiento('RE: Re: Fwd: [WRM] a mystery in the lobby'), true);
  });

  it('reconoce el sufijo de Snov (SPEC.md § 10)', () => {
    assert.equal(esAsuntoDeCalentamiento('Quick question - snv'), true);
  });

  it('no dispara con el marcador en el medio del asunto', () => {
    // Anclarlo es lo que hace que un falso positivo sea difícil: acá el costo de
    // equivocarse es archivar una respuesta real sin que nadie la vea.
    assert.equal(esAsuntoDeCalentamiento('sobre el proyecto [WRM] que mencionaste'), false);
    assert.equal(esAsuntoDeCalentamiento('snv - nuestro proveedor'), false);
  });

  it('deja pasar los asuntos reales de las respuestas anotadas', () => {
    for (const s of [
      'Re: Contact from Allison Taylor @ MyCompany',
      'Out of office',
      'Not interested, thanks',
      '',
    ]) {
      assert.equal(esAsuntoDeCalentamiento(s), false, s);
    }
  });
});

describe('prefiltrar', () => {
  it('un saliente nuestro se ignora sin registrarlo', () => {
    const r = prefiltrar(sobre('ally.taylor@mycompany.co', 'lo que sea'), PROPIOS);
    assert.equal(r?.tipo, 'ignorar');
  });

  it('el dominio propio gana sobre el marcador de calentamiento', () => {
    // Orden deliberado: si el asunto de un saliente nuestro trae [WRM], sigue
    // siendo un saliente y no tiene que ocupar una fila de triage.
    const r = prefiltrar(sobre('ally.taylor@mycompany.co', '[WRM] x'), PROPIOS);
    assert.equal(r?.tipo, 'ignorar');
  });

  it('el calentamiento resuelve la categoría sin clasificador', () => {
    const r = prefiltrar(sobre('ruido@spam-example.com', '[WRM] Your financing info'), PROPIOS);
    assert.deepEqual(r, {
      tipo: 'categoria',
      categoria: 'WARMUP',
      motivo: 'marcador de calentamiento en el asunto',
    });
  });

  it('el default es null: el mensaje sigue el camino completo', () => {
    assert.equal(prefiltrar(sobre('lead@empresa.com', 'Re: quick question'), PROPIOS), null);
  });
});

describe('carpetaQueBloquea — Spam y papelera no pasan por el pipeline', () => {
  it('un mensaje en Spam bloquea', () => {
    assert.equal(carpetaQueBloquea(['SPAM', 'UNREAD']), 'SPAM');
  });

  it('uno en la papelera también', () => {
    assert.equal(carpetaQueBloquea(['TRASH']), 'TRASH');
  });

  it('el inbox normal no bloquea', () => {
    assert.equal(carpetaQueBloquea(['INBOX', 'UNREAD', 'CATEGORY_PERSONAL']), null);
  });

  it('un mensaje ya archivado tampoco bloquea', () => {
    // Sin INBOX y sin SPAM: es correo archivado, y reprocesarlo es legítimo.
    assert.equal(carpetaQueBloquea(['Label_12', 'UNREAD']), null);
  });

  it('una etiqueta que contiene "SPAM" en el nombre no cuenta', () => {
    // Se compara el id exacto de la etiqueta de sistema, no una subcadena: la
    // etiqueta del rescate se llama "BOT - RESCUED FROM SPAM" y un match laxo
    // haría que el propio rescate se bloquee a sí mismo.
    assert.equal(carpetaQueBloquea(['BOT - RESCUED FROM SPAM']), null);
  });
});
