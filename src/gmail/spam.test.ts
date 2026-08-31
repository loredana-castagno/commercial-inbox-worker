import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { origenDe, tocaBarrerSpam } from './spam.js';
import type { MensajeParseado } from './parse.js';

const MENSAJE = {} as MensajeParseado;

describe('tocaBarrerSpam', () => {
  const ahora = new Date('2026-08-25T12:00:00Z');

  it('la primera vez siempre barre', () => {
    // `null` es "nunca se barrió", no "se barrió hace mucho".
    assert.equal(tocaBarrerSpam(null, 12, ahora), true);
  });

  it('no barre antes de tiempo', () => {
    const haceSeisHoras = new Date('2026-08-25T06:00:00Z');
    assert.equal(tocaBarrerSpam(haceSeisHoras, 12, ahora), false);
  });

  it('barre justo al cumplirse el intervalo', () => {
    const haceDoceHoras = new Date('2026-08-25T00:00:00Z');
    assert.equal(tocaBarrerSpam(haceDoceHoras, 12, ahora), true);
  });

  it('barre si pasó más', () => {
    const ayer = new Date('2026-08-24T00:00:00Z');
    assert.equal(tocaBarrerSpam(ayer, 12, ahora), true);
  });
});

describe('origenDe', () => {
  it('nombra las fuentes que lo reconocieron', () => {
    assert.equal(origenDe({ mensaje: MENSAJE, enSnov: true, enCrm: false }), 'Snov');
    assert.equal(origenDe({ mensaje: MENSAJE, enSnov: false, enCrm: true }), 'CRM');
    assert.equal(origenDe({ mensaje: MENSAJE, enSnov: true, enCrm: true }), 'Snov + CRM');
  });

  it('un CRM que no se pudo consultar no cuenta como fuente', () => {
    // `null` es "no se pudo preguntar", no "dijo que sí".
    assert.equal(origenDe({ mensaje: MENSAJE, enSnov: true, enCrm: null }), 'Snov');
  });
});
