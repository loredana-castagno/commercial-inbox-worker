import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { huellaDeEtiquetas, interpretarEtiquetas } from './reproceso.js';

describe('interpretarEtiquetas — la etiqueta es la decisión', () => {
  it('una etiqueta de categoría alcanza', () => {
    const r = interpretarEtiquetas(['INBOX', 'NOT NOW DRIP', 'REPROCESS']);
    assert.deepEqual(r, {
      tipo: 'categoria',
      categoria: 'NOT_NOW',
      daDeBaja: false,
      desconocidas: [],
    });
  });

  it('los nombres reales de la casilla, no los de la taxonomía', () => {
    // "NO THANKS DRIP" es la etiqueta que existe; "NO_THANKS" es el nombre interno
    // de la categoría y no está en la casilla. Es el mismo motivo por el que existe
    // ETIQUETA_DE_CATEGORIA, leído en el otro sentido.
    const real = interpretarEtiquetas(['NO THANKS DRIP']);
    assert.equal(real.tipo === 'categoria' ? real.categoria : null, 'NO_THANKS');

    const interno = interpretarEtiquetas(['NO_THANKS']);
    assert.equal(interno.tipo, 'sin-categoria');
  });

  it('compara sin distinguir mayúsculas', () => {
    // Gmail no admite dos etiquetas que difieran solo en mayúsculas, así que
    // comparar exacto sería inventar una diferencia que la casilla no tiene.
    const r = interpretarEtiquetas(['not now drip']);
    assert.equal(r.tipo === 'categoria' ? r.categoria : null, 'NOT_NOW');
  });
});

describe('interpretarEtiquetas — UNSUBSCRIBE es un modificador', () => {
  it('sola es la categoría UNSUBSCRIBE', () => {
    const r = interpretarEtiquetas(['UNSUBSCRIBE']);
    assert.equal(r.tipo === 'categoria' ? r.categoria : null, 'UNSUBSCRIBE');
    assert.equal(r.tipo === 'categoria' ? r.daDeBaja : null, true);
  });

  it('con REFERRAL es una derivación + baja, no una ambigüedad', () => {
    // El caso del SPEC § 6: "ya no trabajo acá, hablá con Chris". Si UNSUBSCRIBE
    // compitiera como categoría, esto caería en "dos categorías" y el reproceso no
    // haría nada justo en el caso para el que se diseñó.
    const r = interpretarEtiquetas(['REFERRAL', 'UNSUBSCRIBE']);
    assert.equal(r.tipo, 'categoria');
    assert.equal(r.tipo === 'categoria' ? r.categoria : null, 'REFERRAL');
    assert.equal(r.tipo === 'categoria' ? r.daDeBaja : null, true);
  });

  it('con ASK FOR REFERRAL también', () => {
    const r = interpretarEtiquetas(['ASK FOR REFERRAL', 'UNSUBSCRIBE']);
    assert.equal(r.tipo === 'categoria' ? r.categoria : null, 'NOT_RIGHT_CONTACT');
    assert.equal(r.tipo === 'categoria' ? r.daDeBaja : null, true);
  });

  it('ASK FOR REFERRAL sola alcanza: la baja es parte de su receta', () => {
    // No hay que acordarse de poner las dos. El bot completa UNSUBSCRIBE.
    const r = interpretarEtiquetas(['ASK FOR REFERRAL']);
    assert.equal(r.tipo === 'categoria' ? r.categoria : null, 'NOT_RIGHT_CONTACT');
  });
});

describe('interpretarEtiquetas — cuando no se puede leer, no se adivina', () => {
  it('sin ninguna etiqueta de categoría', () => {
    const r = interpretarEtiquetas(['INBOX', 'UNREAD', 'REPROCESS']);
    assert.equal(r.tipo, 'sin-categoria');
  });

  it('dos categorías distintas es ambiguo', () => {
    const r = interpretarEtiquetas(['HOT', 'NO THANKS DRIP', 'REPROCESS']);
    assert.equal(r.tipo, 'ambigua');
    assert.deepEqual(r.tipo === 'ambigua' ? [...r.categorias] : [], ['HOT', 'NO_THANKS']);
  });

  it('REPLIED BEFORE y sus anidadas no son categoría', () => {
    // TO_MANUAL_SORT no tiene ninguna acción externa (SPEC § 13): un reproceso ahí
    // no tendría nada que ejecutar, así que queda a la vista en vez de fingir.
    assert.equal(interpretarEtiquetas(['REPLIED BEFORE']).tipo, 'sin-categoria');
    assert.equal(interpretarEtiquetas(['REPLIED BEFORE/Not now']).tipo, 'sin-categoria');
  });

  it('las etiquetas de trabajo de Ally no cuentan ni molestan', () => {
    const r = interpretarEtiquetas(['ADD TO SF', 'COLD (LAST TRY)', 'NOT NOW DRIP']);
    assert.equal(r.tipo === 'categoria' ? r.categoria : null, 'NOT_NOW');
    assert.deepEqual(r.tipo === 'categoria' ? [...r.desconocidas] : null, []);
  });

  it('una etiqueta que no conoce no bloquea, pero se reporta', () => {
    // Si mañana aparece una etiqueta nueva en la casilla, un reproceso con la
    // categoría bien puesta tiene que seguir funcionando. Se devuelve para el log,
    // que es lo que hace falta para enterarse de que existe.
    const r = interpretarEtiquetas(['NOT NOW DRIP', 'ETIQUETA NUEVA DE ALLY']);
    assert.equal(r.tipo === 'categoria' ? r.categoria : null, 'NOT_NOW');
    assert.deepEqual(r.tipo === 'categoria' ? [...r.desconocidas] : null, ['ETIQUETA NUEVA DE ALLY']);
  });

  it('las de sistema y las del canal con el bot se ignoran', () => {
    const r = interpretarEtiquetas([
      'INBOX',
      'UNREAD',
      'CATEGORY_PERSONAL',
      'IMPORTANT',
      'BOT - TO CHECK',
      'BOT - RESCUED FROM SPAM',
      'REPROCESS',
      'OOO',
    ]);
    assert.equal(r.tipo === 'categoria' ? r.categoria : null, 'OOO');
    assert.deepEqual(r.tipo === 'categoria' ? [...r.desconocidas] : null, []);
  });
});

describe('huellaDeEtiquetas — el candado anti-loop', () => {
  it('el orden en que Gmail devuelve las etiquetas no cambia la huella', () => {
    assert.equal(
      huellaDeEtiquetas(['NOT NOW DRIP', 'REPROCESS']),
      huellaDeEtiquetas(['REPROCESS', 'NOT NOW DRIP']),
    );
  });

  it('reetiquetar cambia la huella: la persona cambió de idea', () => {
    // Es la razón por la que el candado guarda la huella y no un booleano.
    assert.notEqual(
      huellaDeEtiquetas(['NOT NOW DRIP', 'REPROCESS']),
      huellaDeEtiquetas(['NO THANKS DRIP', 'REPROCESS']),
    );
  });

  it('las de sistema no cuentan: que se lea o se archive no es reetiquetar', () => {
    // Sin esto, quitar UNREAD al procesar cambiaría la huella y el correo se
    // reprocesaría de nuevo en la corrida siguiente. El loop que el candado evita.
    assert.equal(
      huellaDeEtiquetas(['INBOX', 'UNREAD', 'NOT NOW DRIP']),
      huellaDeEtiquetas(['NOT NOW DRIP']),
    );
  });
});
