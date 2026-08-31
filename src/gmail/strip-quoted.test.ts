import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { limpiarCitado } from './strip-quoted.js';

/**
 * Los fixtures imitan respuestas reales a las campañas: tres líneas de respuesta
 * y abajo el pitch de MyCompany entero. Lo que se verifica en todos es lo mismo:
 * que la respuesta sobreviva y que el pitch no.
 */

const PITCH = [
  'Hi Marcus,',
  '',
  'I am reaching out because MyCompany helps companies hire senior LATAM engineers',
  'at half the US cost. We handle payroll, compliance and staff augmentation.',
  '',
  'Would you be open to a 15-minute call this week?',
  '',
  'Best,',
  'Allison Taylor',
  'MyCompany',
].join('\n');

describe('limpiarCitado', () => {
  it('corta en "On ... wrote:" de Gmail', () => {
    const r = limpiarCitado(
      `No thanks, we're all set for now.\n\nOn Mon, Aug 17, 2026 at 9:14 AM Allison Taylor <ally.taylor@mycompany.co> wrote:\n> ${PITCH.replace(/\n/g, '\n> ')}`,
    );

    assert.equal(r.texto, "No thanks, we're all set for now.");
    assert.equal(r.cortadoPor, 'on-wrote');
    assert.ok(!r.texto.includes('MyCompany'));
  });

  it('corta cuando el "wrote:" quedó en la línea siguiente', () => {
    const r = limpiarCitado(
      `Not interested at the moment.\n\nOn Mon, Aug 17, 2026 at 9:14 AM Allison Taylor <ally.taylor@mycompany.co>\nwrote:\n\n${PITCH}`,
    );

    assert.equal(r.texto, 'Not interested at the moment.');
    assert.equal(r.cortadoPor, 'on-wrote');
  });

  it('corta en "El ... escribió:" de Gmail en español', () => {
    const r = limpiarCitado(
      `Gracias, por ahora no estamos buscando.\n\nEl lun, 17 ago 2026 a las 9:14, Allison Taylor (<ally.taylor@mycompany.co>) escribió:\n\n${PITCH}`,
    );

    assert.equal(r.texto, 'Gracias, por ahora no estamos buscando.');
    assert.equal(r.cortadoPor, 'on-wrote');
  });

  it('corta en el bloque de headers de Outlook', () => {
    const r = limpiarCitado(
      [
        'Please remove me from your list.',
        '',
        'From: Allison Taylor <ally.taylor@mycompany.co>',
        'Sent: Monday, August 17, 2026 9:14 AM',
        'To: Marcus Webb <marcus@acme.com>',
        'Subject: Contact from Allison Taylor @ MyCompany',
        '',
        PITCH,
      ].join('\n'),
    );

    assert.equal(r.texto, 'Please remove me from your list.');
    assert.equal(r.cortadoPor, 'headers-outlook');
  });

  it('corta en el bloque de headers en alemán', () => {
    // Caso real: anna.weber@mtec-example.com. Antes de cubrir alemán, el
    // clasificador recibía la respuesta de 4 líneas MÁS el pitch entero.
    const r = limpiarCitado(
      [
        'thanks for your email, but the situation is unchanged.',
        'In addition, we work with regional partners in most cases.',
        '',
        'Von: Ally Taylor <allytaylor@mycompany.com>',
        'Gesendet: Freitag, 17. Oktober 2025 14:06',
        'An: Weber Anna <anna.weber@mtec-example.com>',
        'Betreff: Just checking in – anything new on your end?',
        '',
        PITCH,
      ].join('\n'),
    );

    assert.equal(r.cortadoPor, 'headers-outlook');
    assert.ok(!r.texto.includes('MyCompany'));
    assert.ok(r.texto.includes('regional partners'));
  });

  it('corta en el bloque de headers en neerlandés', () => {
    // Caso real: jan.de.vries@plantco.com.
    const r = limpiarCitado(
      [
        'No thanks',
        '',
        'Van: Ally Taylor <ally.taylor@mycompany.com>',
        'Verzonden: vrijdag 10 mei 2024 22:56',
        'Aan: Jan de Vries | PlantCo <jan.de.vries@plantco.com>',
        'Onderwerp: Contact from Allison Taylor at MyCompany to Jan',
        '',
        PITCH,
      ].join('\n'),
    );

    assert.equal(r.texto, 'No thanks');
    assert.equal(r.cortadoPor, 'headers-outlook');
  });

  it('corta en el bloque de headers en portugués', () => {
    // Casos reales: sofia.costa@costafirm.com.br y bsilva@consultco.com.
    // El "De:" ya estaba cubierto; lo que faltaba era "Enviada em:".
    const r = limpiarCitado(
      [
        'Hello Allison, There is nothing at this moment.',
        '',
        'De: Allison Taylor <allisontaylor@mycompany.com>',
        'Enviada em: segunda-feira, 6 de janeiro de 2025 09:21',
        'Para: Bruno Silva <bsilva@consultco.com>',
        'Assunto: Contact from Allison Taylor at MyCompany',
        '',
        PITCH,
      ].join('\n'),
    );

    assert.equal(r.texto, 'Hello Allison, There is nothing at this moment.');
    assert.equal(r.cortadoPor, 'headers-outlook');
  });

  it('corta en "schrieb:" y "schreef:" además de "wrote:"', () => {
    const aleman = limpiarCitado(`Kein Bedarf.\n\nAm 17.08.2026 schrieb Ally Taylor:\n${PITCH}`);
    assert.equal(aleman.texto, 'Kein Bedarf.');

    const neerlandes = limpiarCitado(`Geen interesse.\n\nOp 17 aug 2026 schreef Ally:\n${PITCH}`);
    assert.equal(neerlandes.texto, 'Geen interesse.');
  });

  it('corta en "-----Original Message-----"', () => {
    const r = limpiarCitado(
      `I'm no longer with the company. Contact Sarah at sarah@acme.com\n\n-----Original Message-----\n${PITCH}`,
    );

    assert.equal(r.texto, "I'm no longer with the company. Contact Sarah at sarah@acme.com");
    assert.equal(r.cortadoPor, 'original-message');
  });

  it('corta en el separador de guiones bajos de Outlook', () => {
    const r = limpiarCitado(`We're good, thanks.\n\n________________________________\n${PITCH}`);

    assert.equal(r.texto, "We're good, thanks.");
    assert.equal(r.cortadoPor, 'separador-outlook');
  });

  it('saca el bloque final de líneas con ">" cuando no hay marcador', () => {
    const r = limpiarCitado(`Sounds interesting, can you send details?\n\n> ${PITCH.replace(/\n/g, '\n> ')}`);

    assert.equal(r.texto, 'Sounds interesting, can you send details?');
    assert.equal(r.cortadoPor, 'lineas-citadas');
  });

  it('saca la firma separada con "--"', () => {
    const r = limpiarCitado('Not right now, try me in Q1.\n\n--\nMarcus Webb\nCTO, Acme Inc.\n+1 555 0100');

    assert.equal(r.texto, 'Not right now, try me in Q1.');
    assert.equal(r.firmaQuitada, true);
  });

  it('saca "Sent from my iPhone"', () => {
    const r = limpiarCitado('No thanks\n\nSent from my iPhone');

    assert.equal(r.texto, 'No thanks');
    assert.equal(r.firmaQuitada, true);
  });

  it('usa el marcador más temprano cuando hay varios', () => {
    const r = limpiarCitado(
      [
        'Remove me.',
        '',
        'On Mon, Aug 17, 2026 at 9:14 AM Allison Taylor <ally.taylor@mycompany.co> wrote:',
        '',
        '-----Original Message-----',
        PITCH,
      ].join('\n'),
    );

    assert.equal(r.texto, 'Remove me.');
    assert.equal(r.cortadoPor, 'on-wrote');
  });

  it('no toca un mail sin citado', () => {
    const cuerpo = 'Hi Allison,\n\nWe are hiring 3 backend engineers. Can we talk Thursday?\n\nMarcus';
    const r = limpiarCitado(cuerpo);

    assert.equal(r.texto, cuerpo);
    assert.equal(r.cortadoPor, null);
    assert.equal(r.lineasQuitadas, 0);
  });

  it('no corta en un "From:" que es prosa, sin headers atrás', () => {
    const cuerpo = 'From: what I understand you help with payroll. Is that right?';
    const r = limpiarCitado(cuerpo);

    assert.equal(r.texto, cuerpo);
    assert.equal(r.cortadoPor, null);
  });

  it('devuelve vacío si el mensaje era todo citado, sin explotar', () => {
    const r = limpiarCitado(`> ${PITCH.replace(/\n/g, '\n> ')}`);

    assert.equal(r.texto, '');
    assert.equal(r.cortadoPor, 'lineas-citadas');
  });

  it('normaliza CRLF y colapsa saltos de más', () => {
    const r = limpiarCitado('Line one\r\n\r\n\r\n\r\nLine two\r\n');

    assert.equal(r.texto, 'Line one\n\nLine two');
  });

  it('reporta cuántas líneas se quitaron, para poder auditarlo', () => {
    const r = limpiarCitado(`No thanks.\n\nOn Mon, Aug 17, 2026 at 9:14 AM Ally <a@b.co> wrote:\n${PITCH}`);

    assert.ok(r.lineasQuitadas > 10, `esperaba muchas líneas quitadas, hubo ${r.lineasQuitadas}`);
  });
});
