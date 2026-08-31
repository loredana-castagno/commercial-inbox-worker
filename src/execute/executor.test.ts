import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Category } from '../categories.js';
import type { Accion, Decision } from './acciones.js';
import { ejecutar, type Barreras } from './executor.js';

const APAGADO: Barreras = {
  gmailWriteEnabled: false,
  externalWriteEnabled: false,
  autoCategorias: [],
};

function decision(acciones: Accion[], categoria: Category = 'NO_THANKS'): Decision {
  return { categoriaFinal: categoria, categoriaBase: null, acciones };
}

const ETIQUETAR: Accion = { tipo: 'ETIQUETAR', etiqueta: 'NO_THANKS' };
const SUBIR: Accion = { tipo: 'SUBIR_A_LISTA_SNOV', listaId: '1', nombreDeLista: 'No thanks' };

describe('shadow mode: con los flags apagados no sale nada', () => {
  it('todo queda planeado, nada ejecutado', async () => {
    let llamadas = 0;
    const r = await ejecutar(decision([ETIQUETAR, SUBIR]), APAGADO, async () => {
      llamadas += 1;
    });

    assert.equal(llamadas, 0, 'el ejecutor no se llamó ni una vez');
    assert.ok(r.resultados.every((x) => x.estado === 'planeada'));
  });

  it('el motivo dice qué falta, no solo que no se hizo', async () => {
    const r = await ejecutar(decision([ETIQUETAR]), {
      ...APAGADO,
      autoCategorias: ['NO_THANKS'],
    });
    assert.match(r.resultados[0]?.motivo ?? '', /GMAIL_WRITE_ENABLED=false/);
  });
});

describe('AUTO_CATEGORIES gobierna aparte de los flags', () => {
  const TODO_PRENDIDO: Barreras = {
    gmailWriteEnabled: true,
    externalWriteEnabled: true,
    autoCategorias: [],
  };

  it('con los dos flags prendidos pero sin la categoría, no ejecuta', async () => {
    let llamadas = 0;
    const r = await ejecutar(decision([ETIQUETAR, SUBIR]), TODO_PRENDIDO, async () => {
      llamadas += 1;
    });

    assert.equal(llamadas, 0);
    assert.match(r.resultados[0]?.motivo ?? '', /no está en AUTO_CATEGORIES/);
  });

  it('con la categoría habilitada y los flags prendidos, sí ejecuta', async () => {
    const ejecutadas: string[] = [];
    const r = await ejecutar(
      decision([ETIQUETAR, SUBIR]),
      { ...TODO_PRENDIDO, autoCategorias: ['NO_THANKS'] },
      async (a) => {
        ejecutadas.push(a.tipo);
      },
    );

    assert.deepEqual(ejecutadas, ['ETIQUETAR', 'SUBIR_A_LISTA_SNOV']);
    assert.ok(r.resultados.every((x) => x.estado === 'ejecutada'));
  });

  it('cada flag gobierna lo suyo: Gmail sí, externo no', async () => {
    const ejecutadas: string[] = [];
    await ejecutar(
      decision([ETIQUETAR, SUBIR]),
      { gmailWriteEnabled: true, externalWriteEnabled: false, autoCategorias: ['NO_THANKS'] },
      async (a) => {
        ejecutadas.push(a.tipo);
      },
    );

    assert.deepEqual(ejecutadas, ['ETIQUETAR'], 'la lista de Snov manda correos: no sale');
  });
});

describe('la revisión bloqueante frena todo', () => {
  const TODO: Barreras = {
    gmailWriteEnabled: true,
    externalWriteEnabled: true,
    autoCategorias: ['NO_THANKS'],
  };

  it('con confianza baja no se ejecuta nada, aunque esté todo habilitado', async () => {
    let llamadas = 0;
    const r = await ejecutar(
      decision([
        ETIQUETAR,
        SUBIR,
        { tipo: 'REVISION_HUMANA', motivo: 'confianza 0.4 debajo de 0.75', bloqueante: true },
      ]),
      TODO,
      async () => {
        llamadas += 1;
      },
    );

    assert.equal(llamadas, 0);
    assert.match(r.resultados[0]?.motivo ?? '', /decide una persona.*confianza 0\.4/);
  });

  it('una revisión NO bloqueante deja pasar las acciones', async () => {
    const ejecutadas: string[] = [];
    await ejecutar(
      decision(
        [ETIQUETAR, { tipo: 'REVISION_HUMANA', motivo: 'revisión no bloqueante', bloqueante: false }],
        'NO_THANKS',
      ),
      TODO,
      async (a) => {
        ejecutadas.push(a.tipo);
      },
    );

    assert.deepEqual(ejecutadas, ['ETIQUETAR']);
  });
});

describe('las categorías de NEVER_AUTOMATED no se congelan', () => {
  // HOT y TO_MANUAL_SORT nunca pueden estar en AUTO_CATEGORIES —config.ts lo
  // rechaza al bootear—, pero eso no puede significar que sus acciones nunca
  // salgan: el draft de HOT existe justamente para que una persona lo mire antes
  // de mandarlo (CLAUDE.md #5), y sin este caso ninguna categoría de
  // NEVER_AUTOMATED podría ejecutar nada jamás, aunque los flags estén prendidos.
  const TODO_SIN_HOT: Barreras = {
    gmailWriteEnabled: true,
    externalWriteEnabled: true,
    // A propósito sin 'HOT': así es siempre en producción, porque no puede
    // estar de otra forma.
    autoCategorias: ['NO_THANKS'],
  };

  it('HOT ejecuta etiqueta, lead y draft aunque HOT no esté en AUTO_CATEGORIES', async () => {
    const ejecutadas: string[] = [];
    const r = await ejecutar(
      decision(
        [
          { tipo: 'ETIQUETAR', etiqueta: 'HOT' },
          { tipo: 'CREAR_LEAD_CRM', rating: 'Hot', diasDeDueDate: 3 },
          { tipo: 'CREAR_DRAFT', template: 'Position details HOT' },
          { tipo: 'DEJAR_EN_INBOX', motivo: 'lo resuelve una persona' },
        ],
        'HOT',
      ),
      TODO_SIN_HOT,
      async (a) => {
        ejecutadas.push(a.tipo);
      },
    );

    assert.deepEqual(ejecutadas, ['ETIQUETAR', 'CREAR_LEAD_CRM', 'CREAR_DRAFT']);
    assert.ok(r.resultados.every((x) => x.estado === 'ejecutada' || x.estado === 'registrada'));
  });

  it('TO_MANUAL_SORT etiqueta REPLIED BEFORE aunque no esté en AUTO_CATEGORIES', async () => {
    const ejecutadas: string[] = [];
    await ejecutar(
      decision([{ tipo: 'ETIQUETAR', etiqueta: 'REPLIED BEFORE/No thanks' }], 'TO_MANUAL_SORT'),
      TODO_SIN_HOT,
      async (a) => {
        ejecutadas.push(a.tipo);
      },
    );

    assert.deepEqual(ejecutadas, ['ETIQUETAR']);
  });

  it('igual respeta GMAIL_WRITE_ENABLED y EXTERNAL_WRITE_ENABLED', async () => {
    const r = await ejecutar(
      decision([{ tipo: 'ETIQUETAR', etiqueta: 'HOT' }], 'HOT'),
      { ...TODO_SIN_HOT, gmailWriteEnabled: false },
    );

    assert.equal(r.resultados[0]?.estado, 'planeada');
    assert.match(r.resultados[0]?.motivo ?? '', /GMAIL_WRITE_ENABLED=false/);
  });
});

describe('sin cliente de escritura conectado', () => {
  it('lo dice explícitamente en vez de fingir que ejecutó', async () => {
    const r = await ejecutar(decision([ETIQUETAR]), {
      gmailWriteEnabled: true,
      externalWriteEnabled: true,
      autoCategorias: ['NO_THANKS'],
    });

    assert.equal(r.resultados[0]?.estado, 'planeada');
    assert.match(r.resultados[0]?.motivo ?? '', /no hay cliente de escritura/);
  });
});

describe('lo que no sale del sistema se registra', () => {
  it('DEJAR_EN_INBOX y REVISION_HUMANA no pasan por barreras', async () => {
    const r = await ejecutar(
      decision([
        { tipo: 'DEJAR_EN_INBOX', motivo: 'lo resuelve una persona' },
        { tipo: 'REVISION_HUMANA', motivo: 'x', bloqueante: false },
      ]),
      APAGADO,
    );

    assert.ok(r.resultados.every((x) => x.estado === 'registrada'));
    assert.equal(r.necesitaRevision, true);
  });
});

describe('la marca de revisión sobrevive al bloqueo', () => {
  // Es la razón de ser de ETIQUETAR_REVISION: una revisión bloqueante frena todas
  // las acciones, y si ésta se frenara con las demás el mail quedaría en el inbox
  // sin ninguna señal de que el bot lo miró y no se animó.
  const MARCA: Accion = { tipo: 'ETIQUETAR_REVISION', etiqueta: 'BOT - TO CHECK' };
  const BLOQUEO: Accion = {
    tipo: 'REVISION_HUMANA',
    motivo: 'confianza 0.4 debajo de 0.75',
    bloqueante: true,
  };

  it('se ejecuta aunque todo lo demás quede frenado', async () => {
    const ejecutadas: string[] = [];
    const r = await ejecutar(
      decision([ETIQUETAR, SUBIR, MARCA, BLOQUEO]),
      { gmailWriteEnabled: true, externalWriteEnabled: true, autoCategorias: ['NO_THANKS'] },
      async (a) => {
        ejecutadas.push(a.tipo);
      },
    );

    assert.deepEqual(ejecutadas, ['ETIQUETAR_REVISION'], 'solo salió la marca');
    assert.equal(
      r.resultados.find((x) => x.accion.tipo === 'ETIQUETAR_REVISION')?.estado,
      'ejecutada',
    );
    assert.equal(r.resultados.find((x) => x.accion.tipo === 'ETIQUETAR')?.estado, 'planeada');
  });

  it('no depende de AUTO_CATEGORIES', async () => {
    // OTHER nunca puede estar en AUTO_CATEGORIES, y es justo uno de los casos que
    // hay que marcar: el bot no entendió el mail.
    const ejecutadas: string[] = [];
    await ejecutar(
      decision([MARCA], 'OTHER'),
      { gmailWriteEnabled: true, externalWriteEnabled: false, autoCategorias: [] },
      async (a) => {
        ejecutadas.push(a.tipo);
      },
    );

    assert.deepEqual(ejecutadas, ['ETIQUETAR_REVISION']);
  });

  it('sí respeta GMAIL_WRITE_ENABLED: es una escritura en la casilla', async () => {
    let llamadas = 0;
    const r = await ejecutar(decision([MARCA]), APAGADO, async () => {
      llamadas += 1;
    });

    assert.equal(llamadas, 0);
    assert.match(r.resultados[0]?.motivo ?? '', /GMAIL_WRITE_ENABLED=false/);
  });
});
