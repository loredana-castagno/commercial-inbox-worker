import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Category } from '../categories.js';
import type { GmailClient } from './client.js';
import { ancestrosDe, ETIQUETA_DE_CATEGORIA, etiquetaDeManualSort } from './etiquetas.js';
import { GmailWriter } from './escritor.js';

interface Registro {
  readonly tipo: 'modificar' | 'crear-etiqueta' | 'draft';
  readonly args: readonly unknown[];
}

function clienteFalso(
  registro: Registro[],
  etiquetas: { id: string; name: string }[] = [],
): GmailClient {
  let proximoId = 1;
  return {
    listarEtiquetas: async () => ({ labels: etiquetas }),
    modificarEtiquetas: async (id: string, cambios: unknown) => {
      registro.push({ tipo: 'modificar', args: [id, cambios] });
    },
    crearEtiqueta: async (nombre: string) => {
      registro.push({ tipo: 'crear-etiqueta', args: [nombre] });
      const creada = { id: `nueva-${proximoId++}`, name: nombre };
      etiquetas.push(creada);
      return creada;
    },
    crearDraft: async (params: unknown) => {
      registro.push({ tipo: 'draft', args: [params] });
      return { id: 'draft-1' };
    },
  } as unknown as GmailClient;
}

const HABILITADO = { gmailWriteEnabled: true };

describe('la barrera', () => {
  it('sin el flag, GmailWriter.crear devuelve undefined', () => {
    assert.equal(GmailWriter.crear(clienteFalso([]), { gmailWriteEnabled: false }), undefined);
  });
});

describe('nunca borra', () => {
  // En Gmail la papelera ES una etiqueta: users.messages.modify puede borrar un
  // mail con addLabelIds: ['TRASH']. No alcanza con no llamar a .trash().
  for (const prohibida of ['TRASH', 'SPAM', 'trash']) {
    it(`rechaza aplicar "${prohibida}" antes de llamar a la API`, async () => {
      const registro: Registro[] = [];
      const writer = GmailWriter.crear(clienteFalso(registro), HABILITADO);

      await assert.rejects(() => writer!.etiquetar('m1', prohibida), /nunca borra/);
      assert.equal(registro.length, 0, 'no salió ninguna llamada');
    });
  }

  it('sacar del inbox quita INBOX y UNREAD, no manda a la papelera', async () => {
    // El "leído" va atado al archivado: si el bot lo resolvió y lo sacó de la vista,
    // dejarlo sin leer solo infla un contador que nadie baja.
    const registro: Registro[] = [];
    const writer = GmailWriter.crear(clienteFalso(registro), HABILITADO);

    await writer!.sacarDelInbox('m1');

    assert.deepEqual(registro[0], {
      tipo: 'modificar',
      args: ['m1', { quitar: ['INBOX', 'UNREAD'] }],
    });
  });

  it('etiquetar también marca leído, aunque el mail se quede en el inbox', async () => {
    // Es lo que le da significado a "sin leer": si el bot lo tocó, está leído.
    // Sin leer pasa a querer decir "el bot todavía no llegó", que es un dato útil.
    const registro: Registro[] = [];
    const writer = GmailWriter.crear(
      clienteFalso(registro, [{ id: 'L1', name: 'HOT' }]),
      HABILITADO,
    );

    await writer!.etiquetar('m1', 'HOT');

    assert.deepEqual(registro[0], {
      tipo: 'modificar',
      args: ['m1', { agregar: ['L1'], quitar: ['UNREAD'] }],
    });
  });
});

describe('sacar de spam es lo contrario de borrar', () => {
  it('quita SPAM, devuelve al inbox y etiqueta', async () => {
    // Quitar SPAM sin agregar INBOX dejaría el mail en el limbo: fuera de spam
    // pero sin aparecer en ningún lado.
    const registro: Registro[] = [];
    const writer = GmailWriter.crear(
      clienteFalso(registro, [{ id: 'L7', name: 'BOT - RESCUED FROM SPAM' }]),
      HABILITADO,
    );

    await writer!.sacarDeSpam('m1', 'BOT - RESCUED FROM SPAM');

    assert.deepEqual(registro[0], {
      tipo: 'modificar',
      args: ['m1', { agregar: ['INBOX', 'L7'], quitar: ['SPAM', 'UNREAD'] }],
    });
  });

  it('sigue sin poder etiquetar con SPAM', async () => {
    // La operación inversa sigue prohibida: se puede sacar de spam, nunca mandar.
    const registro: Registro[] = [];
    const writer = GmailWriter.crear(clienteFalso(registro), HABILITADO);

    await assert.rejects(() => writer!.sacarDeSpam('m1', 'SPAM'), /nunca borra/);
    assert.equal(registro.length, 0);
  });
});

describe('resolución de etiquetas', () => {
  it('reusa la que ya existe en vez de crear una nueva', async () => {
    const registro: Registro[] = [];
    const writer = GmailWriter.crear(
      clienteFalso(registro, [{ id: 'L1', name: 'NO THANKS DRIP' }]),
      HABILITADO,
    );

    await writer!.etiquetar('m1', 'NO THANKS DRIP');

    assert.ok(!registro.some((r) => r.tipo === 'crear-etiqueta'));
    assert.deepEqual(registro[0], {
      tipo: 'modificar',
      args: ['m1', { agregar: ['L1'], quitar: ['UNREAD'] }],
    });
  });

  it('busca sin distinguir mayúsculas', async () => {
    // Gmail no admite dos etiquetas que difieran solo en mayúsculas: comparar
    // exacto intentaría crear una duplicada.
    const registro: Registro[] = [];
    const writer = GmailWriter.crear(
      clienteFalso(registro, [{ id: 'L1', name: 'NO THANKS DRIP' }]),
      HABILITADO,
    );

    await writer!.etiquetar('m1', 'no thanks drip');
    assert.ok(!registro.some((r) => r.tipo === 'crear-etiqueta'));
  });

  it('crea los padres antes que la anidada', async () => {
    // "REPLIED BEFORE/No thanks" sin "REPLIED BEFORE" queda como una etiqueta huérfana con una
    // barra en el nombre.
    const registro: Registro[] = [];
    const writer = GmailWriter.crear(clienteFalso(registro), HABILITADO);

    await writer!.etiquetar('m1', 'REPLIED BEFORE/No thanks');

    const creadas = registro.filter((r) => r.tipo === 'crear-etiqueta').map((r) => r.args[0]);
    assert.deepEqual(creadas, ['REPLIED BEFORE', 'REPLIED BEFORE/No thanks']);
  });

  it('no recrea el padre si ya existe', async () => {
    const registro: Registro[] = [];
    const writer = GmailWriter.crear(
      clienteFalso(registro, [{ id: 'L9', name: 'REPLIED BEFORE' }]),
      HABILITADO,
    );

    await writer!.etiquetar('m1', 'REPLIED BEFORE/No thanks');

    const creadas = registro.filter((r) => r.tipo === 'crear-etiqueta').map((r) => r.args[0]);
    assert.deepEqual(creadas, ['REPLIED BEFORE/No thanks']);
  });

  it('cachea: dos mails con la misma etiqueta listan una sola vez', async () => {
    const registro: Registro[] = [];
    const cliente = clienteFalso(registro, [{ id: 'L1', name: 'OOO' }]);
    let listados = 0;
    const espiado = {
      ...cliente,
      listarEtiquetas: async () => {
        listados += 1;
        return { labels: [{ id: 'L1', name: 'OOO' }] };
      },
    } as unknown as GmailClient;

    const writer = GmailWriter.crear(espiado, HABILITADO);
    await writer!.etiquetar('m1', 'OOO');
    await writer!.etiquetar('m2', 'OOO');

    assert.equal(listados, 1);
  });
});

describe('el mapeo a las etiquetas reales de Ally', () => {
  it('NO_THANKS no es "NO_THANKS"', () => {
    // Relevado contra la casilla: la etiqueta se llama NO THANKS DRIP. Emitir la
    // categoría cruda habría creado una etiqueta nueva al lado de la suya.
    assert.deepEqual(ETIQUETA_DE_CATEGORIA.NO_THANKS, ['NO THANKS DRIP']);
    assert.deepEqual(ETIQUETA_DE_CATEGORIA.NOT_NOW, ['NOT NOW DRIP']);
    assert.deepEqual(ETIQUETA_DE_CATEGORIA.EMAIL_MODIFIED, ['EMAIL MODIFIED']);
    assert.deepEqual(ETIQUETA_DE_CATEGORIA.TO_MANUAL_SORT, ['REPLIED BEFORE']);
  });

  it('las que ya coincidían siguen igual', () => {
    for (const c of ['OOO', 'HOT', 'REFERRAL', 'UNSUBSCRIBE', 'UNDELIVERABLE'] as const) {
      assert.deepEqual(ETIQUETA_DE_CATEGORIA[c], [c]);
    }
  });

  it('NOT_RIGHT_CONTACT lleva las dos: ASK FOR REFERRAL y UNSUBSCRIBE', () => {
    // Cada una dice una mitad: ASK FOR REFERRAL qué es el correo, UNSUBSCRIBE la
    // consecuencia. Antes llevaba solo UNSUBSCRIBE y esa etiqueta significaba dos
    // cosas distintas según dónde apareciera el mail.
    assert.deepEqual(ETIQUETA_DE_CATEGORIA.NOT_RIGHT_CONTACT, [
      'ASK FOR REFERRAL',
      'UNSUBSCRIBE',
    ]);
  });

  it('UNSUBSCRIBE significa lo mismo en toda la casilla', () => {
    // La invariante que habilitó separar ASK FOR REFERRAL: donde aparezca la
    // etiqueta UNSUBSCRIBE, esa dirección salió de las campañas. Sin excepciones.
    const conUnsubscribe = (Object.keys(ETIQUETA_DE_CATEGORIA) as Category[]).filter((c) =>
      ETIQUETA_DE_CATEGORIA[c].includes('UNSUBSCRIBE'),
    );
    assert.deepEqual(conUnsubscribe.sort(), ['NOT_RIGHT_CONTACT', 'UNSUBSCRIBE']);
  });

  it('lo que se archiva lleva etiqueta, para poder auditarlo', () => {
    // Sin etiqueta desaparecen del inbox sin dejar rastro, y son justo las dos que
    // hay que poder revisar desde Gmail.
    assert.deepEqual(ETIQUETA_DE_CATEGORIA.NO_ES_RESPUESTA, ['NOT A REPLY']);
  });

  it('WEBSITE_CONTACT tampoco: llega de @mycompany y el prefiltro lo descarta', () => {
    assert.deepEqual(ETIQUETA_DE_CATEGORIA.WEBSITE_CONTACT, []);
  });

  it('OTHER sigue sin etiqueta de categoría', () => {
    // Es "no sé": una etiqueta de categoría le daría una certeza que no tiene.
    // Lleva BOT - TO CHECK, que es lo que realmente pasó.
    assert.deepEqual(ETIQUETA_DE_CATEGORIA.OTHER, []);
  });

  it('la anidada cuelga del nombre real del padre', () => {
    assert.equal(etiquetaDeManualSort('NO_THANKS'), 'REPLIED BEFORE/No thanks');
    assert.equal(etiquetaDeManualSort(null), null);
    // Una categoría sin sub-etiqueta definida no arma un nombre inventado.
    assert.equal(etiquetaDeManualSort('OOO'), null);
  });
});

describe('ancestrosDe', () => {
  it('lista los padres de una anidada', () => {
    assert.deepEqual(ancestrosDe('A/B/C'), ['A', 'A/B']);
  });

  it('una etiqueta plana no tiene padres', () => {
    assert.deepEqual(ancestrosDe('OOO'), []);
  });
});
