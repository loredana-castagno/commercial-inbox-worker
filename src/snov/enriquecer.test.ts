import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  campanasQueCuentan,
  derivarEnriquecimiento,
  esCampanaDeFU,
  yaEnListaDe,
  type ListasDeCategoria,
} from './enriquecer.js';
import { prospectSchema } from './schemas.js';

/**
 * Los fixtures son respuestas **reales** de la cuenta de Snov, capturadas en
 * agosto 2026. Un fixture inventado prueba que el código hace lo que pensé; éstos
 * prueban que maneja lo que Snov manda.
 */

const JAN = prospectSchema.parse({
  id: '3d641fc4d2bd58f00b6e3933814cce8df29ff9a1c2d652549c4ed20eaf8b10c481441a427985',
  name: 'Jan De Nood',
  firstName: 'Jan',
  lastName: 'de Nood',
  lists: [{ id: 3000001, name: 'Leads - No thanks Inbox' }],
  campaigns: [
    {
      id: 4000001,
      name: 'FU Campaign - No thanks',
      campaign_status: 'Active',
      recipients: [{ email: 'jan.de.vries@plantco.com', recipient_status: 'Auto-replied', sent: '1', reply: '0' }],
    },
  ],
});

const RUPESH = prospectSchema.parse({
  id: 'a1b2c3',
  name: 'Rupesh Walavalkar',
  lists: [
    { id: 3000004, name: 'KDM (Dice)' },
    { id: 3000001, name: 'Leads - No thanks Inbox' },
  ],
  campaigns: [
    { id: 3000003, name: 'KDM - Job Posts (Dice)', campaign_status: 'Unrecognized', recipients: [] },
    { id: 4000001, name: 'FU Campaign - No thanks', campaign_status: 'Active', recipients: [] },
  ],
});

const LISTAS: ListasDeCategoria = {
  NO_THANKS: '3000001',
  NOT_NOW: '3000002',
  REFERRAL: '2000002',
};

describe('esCampanaDeFU', () => {
  it('reconoce las nueve campañas de FU de la cuenta', () => {
    for (const n of [
      'FU Campaign - No thanks',
      'FU Campaign - Not now',
      'FU Campaign - Referrals',
      'FU Campaign Job Posts',
      'FU Campaign ALL READ team',
    ]) {
      assert.equal(esCampanaDeFU(n), true, n);
    }
  });

  it('NO matchea cuando el FU está en el medio', () => {
    // Caso real: si el patrón fuera "contiene FU", esta campaña de candidatos
    // quedaría excluida del conteo por la razón equivocada.
    assert.equal(esCampanaDeFU('2026/7/31 - FU Candidate Campaign (Windows Infra) - Brazil'), false);
  });

  it('no confunde palabras que empiezan con FU', () => {
    assert.equal(esCampanaDeFU('Future Leads 2026'), false);
    assert.equal(esCampanaDeFU('FUNDING - Series B targets'), false);
  });
});

describe('campanasQueCuentan', () => {
  it('un prospect que solo recibió el FU de su lista no llega al umbral', () => {
    // Es el caso más común: respondió una vez, se lo cargó, le llegó el FU.
    assert.deepEqual(campanasQueCuentan(JAN.campaigns ?? []), []);
  });

  it('cuenta la comercial y descarta la de FU', () => {
    assert.deepEqual(campanasQueCuentan(RUPESH.campaigns ?? []), ['KDM - Job Posts (Dice)']);
  });
});

describe('derivarEnriquecimiento', () => {
  it('sin prospect devuelve la señal de "no le escribimos"', () => {
    const e = derivarEnriquecimiento(undefined);
    assert.equal(e.esProspect, false);
    assert.equal(e.multiCampana, false);
    assert.deepEqual(e.listas, []);
  });

  it('un prospect con una comercial + una de FU no dispara multi-campaña', () => {
    const e = derivarEnriquecimiento(RUPESH);

    assert.equal(e.esProspect, true);
    assert.equal(e.campanas.length, 2, 'las dos viajan como contexto');
    assert.deepEqual(e.campanasQueCuentan, ['KDM - Job Posts (Dice)']);
    assert.equal(e.multiCampana, false, 'sin la exclusión de FU esto daría 2 y sería un falso positivo');
  });

  it('dos comerciales sí disparan multi-campaña, con los nombres', () => {
    const dos = prospectSchema.parse({
      id: 'x',
      lists: [],
      campaigns: [
        { id: 1, name: 'KDM - Job Posts (Dice)' },
        { id: 2, name: '202509 - Forbes 100 Cloud - CEO/F - AI' },
        { id: 3, name: 'FU Campaign - No thanks' },
      ],
    });
    const e = derivarEnriquecimiento(dos);

    assert.equal(e.multiCampana, true);
    assert.deepEqual(e.campanasQueCuentan, [
      'KDM - Job Posts (Dice)',
      '202509 - Forbes 100 Cloud - CEO/F - AI',
    ]);
  });

  it('sobrevive a un prospect sin listas ni campañas', () => {
    const e = derivarEnriquecimiento(prospectSchema.parse({ id: 'y' }));
    assert.equal(e.esProspect, true);
    assert.deepEqual(e.campanas, []);
  });
});

describe('yaEnListaDe — la regla de segunda respuesta', () => {
  it('detecta que ya está en la lista de No thanks', () => {
    assert.equal(yaEnListaDe(JAN.lists ?? [], 'NO_THANKS', LISTAS), true);
  });

  it('no confunde con otra lista de la misma persona', () => {
    // Rupesh está en KDM (Dice) y en No thanks: un NOT_NOW no es segunda vuelta.
    assert.equal(yaEnListaDe(RUPESH.lists ?? [], 'NOT_NOW', LISTAS), false);
    assert.equal(yaEnListaDe(RUPESH.lists ?? [], 'NO_THANKS', LISTAS), true);
  });

  it('las categorías sin lista de primera ronda nunca son segunda vuelta', () => {
    assert.equal(yaEnListaDe(JAN.lists ?? [], 'HOT', LISTAS), false);
    assert.equal(yaEnListaDe(JAN.lists ?? [], 'UNSUBSCRIBE', LISTAS), false);
  });

  it('compara por id y no por nombre: el nombre trae apóstrofe tipográfico', () => {
    // "Ally’s" con U+2019, no comilla simple. Comparar por nombre sería frágil.
    assert.equal(yaEnListaDe([{ id: 3000001, name: 'otro nombre' }], 'NO_THANKS', LISTAS), true);
  });
});

describe('varios perfiles para la misma dirección', () => {
  // En Snov la misma dirección puede tener un perfil por lista: es lo que deja
  // `createDuplicates`, la única forma que da la API de sumar a una lista a
  // alguien que ya existe en otra. Leer solo `data[0]` escondía las listas de los
  // demás perfiles — y con eso, que el prospect ya estaba en la lista de su
  // categoría (agosto 2026).
  const enCampana = {
    id: 'a',
    name: 'Loredana',
    lists: [{ id: 3000005, name: 'Job Post (Sales Automation)' }],
    campaigns: [{ id: 1, name: 'KDM - Job Posts' }],
  };
  const enNotNow = {
    id: 'b',
    name: 'Loredana',
    lists: [{ id: 3000002, name: "Leads - Not now Inbox" }],
    campaigns: [{ id: 2, name: 'FU Campaign - Not now' }],
  };

  it('une las listas de todos los perfiles', () => {
    const e = derivarEnriquecimiento([enCampana, enNotNow]);
    assert.deepEqual(
      e.listas.map((l) => l.id).sort(),
      [3000002, 3000005],
    );
  });

  it('con la unión, la segunda respuesta sí se detecta', () => {
    // Es la consecuencia que importa: sin esto, un segundo "ahora no" volvía a
    // subirse a la lista en vez de ir a REPLIED BEFORE.
    const e = derivarEnriquecimiento([enCampana, enNotNow]);
    const ids = { NO_THANKS: '1', NOT_NOW: '3000002', REFERRAL: '3' };
    assert.equal(yaEnListaDe(e.listas, 'NOT_NOW', ids), true);
    assert.equal(
      yaEnListaDe(derivarEnriquecimiento([enCampana]).listas, 'NOT_NOW', ids),
      false,
      'con un solo perfil no se detecta: es el bug que había',
    );
  });

  it('no cuenta dos veces la misma campaña', () => {
    const e = derivarEnriquecimiento([enCampana, { ...enNotNow, campaigns: enCampana.campaigns }]);
    assert.deepEqual(e.campanas, ['KDM - Job Posts']);
  });

  it('sigue aceptando un solo prospect suelto', () => {
    assert.equal(derivarEnriquecimiento(enCampana).esProspect, true);
    assert.equal(derivarEnriquecimiento(undefined).esProspect, false);
  });
});
