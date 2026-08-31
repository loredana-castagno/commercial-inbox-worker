import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SIN_PROSPECT, type Enriquecimiento } from '../snov/enriquecer.js';
import { barreraDe, describir, type Accion } from './acciones.js';
import { decidir, type ContextoDeDecision } from './handlers.js';

const LISTAS = {
  NO_THANKS: '3000001',
  NOT_NOW: '3000002',
  REFERRAL: '2000002',
};
const DOMINIOS = ['mycompany.co', 'mycompany.com', 'mycompany.net'];

function ctx(over: Partial<ContextoDeDecision> = {}): ContextoDeDecision {
  return {
    categoria: 'NO_THANKS',
    confianza: 0.9,
    emailDelRemitente: 'marcus@acme.com',
    enriquecimiento: { ...SIN_PROSPECT, esProspect: true },
    enriquecimientoDisponible: true,
    listas: LISTAS,
    umbralDeConfianza: 0.75,
    dominiosPropios: DOMINIOS,
    // Por default "no existe en el CRM": los tests que quieren el otro caso lo dicen.
    crm: { existe: false },
    // Por default no hay dirección nueva que migrar.
    emailNuevo: null,
    // Ni referido que subir, ni nadie que se haya ido de su empresa.
    referidoEmail: null,
    referidoNombre: null,
    dejoLaEmpresa: false,
    ...over,
  };
}

const tipos = (acciones: readonly Accion[]): string[] => acciones.map((a) => a.tipo);

describe('decidir — consecuencias por categoría', () => {
  it('NO_THANKS: etiqueta, sube a su lista y saca del inbox', () => {
    // El archivado va último porque la decisión de inbox se toma después de las
    // consecuencias por categoría: una de sus condiciones es si hubo draft.
    const d = decidir(ctx());
    assert.deepEqual(tipos(d.acciones), ['ETIQUETAR', 'SUBIR_A_LISTA_SNOV', 'SACAR_DE_INBOX']);
    assert.equal(d.categoriaFinal, 'NO_THANKS');
  });

  it('NOT_NOW: arma el draft de cold last try y NO archiva', () => {
    // Todo mail con draft se queda en el inbox: el borrador vive en Borradores y
    // sin el hilo a la vista no queda nada que recuerde revisarlo.
    const d = decidir(ctx({ categoria: 'NOT_NOW' }));
    assert.ok(d.acciones.some((a) => a.tipo === 'CREAR_DRAFT' && a.template === 'Cold last try'));
    assert.ok(tipos(d.acciones).includes('DEJAR_EN_INBOX'));
    assert.ok(!tipos(d.acciones).includes('SACAR_DE_INBOX'));
  });

  it('la regla del draft mira las acciones, no la categoría', () => {
    // Escrito así para que valga sola si alguna categoría nueva empieza a generar
    // drafts, sin que haya que acordarse de sumarla a una lista.
    for (const categoria of ['NOT_NOW', 'NOT_RIGHT_CONTACT', 'HOT'] as const) {
      const d = decidir(ctx({ categoria, confianza: 0.99 }));
      if (d.acciones.some((a) => a.tipo === 'CREAR_DRAFT')) {
        assert.ok(
          tipos(d.acciones).includes('DEJAR_EN_INBOX'),
          `${categoria} genera draft y tiene que quedarse en el inbox`,
        );
        assert.ok(!tipos(d.acciones).includes('SACAR_DE_INBOX'), `${categoria} no se archiva`);
      }
    }
  });

  it('HOT: queda en el inbox, crea lead y SIEMPRE va a revisión humana', () => {
    const d = decidir(ctx({ categoria: 'HOT', confianza: 0.99 }));
    assert.ok(tipos(d.acciones).includes('DEJAR_EN_INBOX'));
    assert.ok(!tipos(d.acciones).includes('SACAR_DE_INBOX'));
    assert.ok(tipos(d.acciones).includes('CREAR_LEAD_CRM'));
    assert.ok(tipos(d.acciones).includes('REVISION_HUMANA'), 'HOT nunca se automatiza');
  });

  it('UNSUBSCRIBE: sube a do-not-email', () => {
    const d = decidir(ctx({ categoria: 'UNSUBSCRIBE' }));
    assert.ok(d.acciones.some((a) => a.tipo === 'SUBIR_A_DO_NOT_EMAIL'));
  });
});

describe('decidir — la dirección propia nunca va a do-not-email', () => {
  for (const propio of [
    'ally.taylor@mycompany.co',
    'allisontaylor@mycompany.com',
    'allyjtaylor@mycompany.net',
  ]) {
    it(`bloquea ${propio}`, () => {
      const d = decidir(ctx({ categoria: 'UNSUBSCRIBE', emailDelRemitente: propio }));

      assert.ok(
        !d.acciones.some((a) => a.tipo === 'SUBIR_A_DO_NOT_EMAIL'),
        'subirla mataría la campaña que sale desde ese alias',
      );
      assert.ok(d.acciones.some((a) => a.tipo === 'REVISION_HUMANA'));
    });
  }

  it('un dominio parecido pero ajeno sí se sube', () => {
    const d = decidir(ctx({ categoria: 'UNSUBSCRIBE', emailDelRemitente: 'ally@mycompany.io' }));
    assert.ok(d.acciones.some((a) => a.tipo === 'SUBIR_A_DO_NOT_EMAIL'));
  });
});

describe('decidir — segunda respuesta', () => {
  const yaEnNoThanks: Enriquecimiento = {
    ...SIN_PROSPECT,
    esProspect: true,
    listas: [{ id: 3000001, name: "Leads - No thanks Inbox" }],
  };

  it('promueve a TO_MANUAL_SORT y conserva la categoría base', () => {
    const d = decidir(ctx({ categoria: 'NO_THANKS', enriquecimiento: yaEnNoThanks }));

    assert.equal(d.categoriaFinal, 'TO_MANUAL_SORT');
    assert.equal(d.categoriaBase, 'NO_THANKS');
    // El padre es "REPLIED BEFORE": nombra qué es el correo, no qué hacer con él.
    // La anidada es
    // nueva y es la que pidió. Ver src/gmail/etiquetas.ts.
    assert.ok(
      d.acciones.some((a) => a.tipo === 'ETIQUETAR' && a.etiqueta === 'REPLIED BEFORE/No thanks'),
    );
  });

  it('no sube a ninguna lista: la persona decide', () => {
    const d = decidir(ctx({ categoria: 'NO_THANKS', enriquecimiento: yaEnNoThanks }));
    assert.ok(!tipos(d.acciones).includes('SUBIR_A_LISTA_SNOV'));
    assert.ok(tipos(d.acciones).includes('DEJAR_EN_INBOX'));
  });

  it('un NOT_NOW de alguien que está en la lista de No thanks NO es segunda vuelta', () => {
    const d = decidir(ctx({ categoria: 'NOT_NOW', enriquecimiento: yaEnNoThanks }));
    assert.equal(d.categoriaFinal, 'NOT_NOW');
  });

  it('sin Snov no se promueve: no se puede saber si es la segunda vez', () => {
    const d = decidir(
      ctx({ categoria: 'NO_THANKS', enriquecimiento: yaEnNoThanks, enriquecimientoDisponible: false }),
    );
    assert.equal(d.categoriaFinal, 'NO_THANKS');
    assert.ok(d.acciones.some((a) => a.tipo === 'REVISION_HUMANA' && a.motivo.includes('Snov')));
  });

  it('REFERRAL ya no tiene segunda vuelta: a esa lista va el referido, no el remitente', () => {
    // La detección miraba si el remitente estaba en la lista de primera ronda de su
    // categoría, y funcionaba solo porque el handler lo subía ahí por error. Con el
    // alta apuntando al referido, el remitente no aparece nunca en esa lista.
    const yaEnReferrals: Enriquecimiento = {
      ...SIN_PROSPECT,
      esProspect: true,
      listas: [{ id: 2000002, name: "Leads - Referrals Inbox" }],
    };
    const d = decidir(
      ctx({
        categoria: 'REFERRAL',
        enriquecimiento: yaEnReferrals,
        referidoEmail: 'otro@acme.com',
      }),
    );
    assert.equal(d.categoriaFinal, 'REFERRAL');
    assert.equal(d.categoriaBase, null);
  });
});

describe('REFERRAL sube al referido, no al que escribió (SPEC § 6)', () => {
  const alta = (d: { acciones: readonly Accion[] }) =>
    d.acciones.find((a) => a.tipo === 'SUBIR_A_LISTA_SNOV') as
      | Extract<Accion, { tipo: 'SUBIR_A_LISTA_SNOV' }>
      | undefined;

  it('el alta lleva la dirección y el nombre del referido', () => {
    // El caso real: Alex Turner contesta que ya no trabaja ahí y deriva a Chris
    // Palmer. A la lista de Referrals va Chris, no Alex — y con el nombre de Chris,
    // que es el que después usa el {{first_name}} de la campaña.
    const d = decidir(
      ctx({
        categoria: 'REFERRAL',
        emailDelRemitente: 'aturner@northwind.com',
        referidoEmail: 'cpalmer@northwind.com',
        referidoNombre: 'Chris Palmer',
      }),
    );

    assert.equal(alta(d)?.email, 'cpalmer@northwind.com');
    assert.equal(alta(d)?.nombre, 'Chris Palmer');
    assert.equal(alta(d)?.listaId, LISTAS.REFERRAL);
  });

  it('sin la dirección del referido no adivina: decide una persona', () => {
    // Archivar igual perdería el referido en silencio, que es el único dato nuevo
    // que trajo el mail. Misma guarda que EMAIL_MODIFIED sin dirección nueva.
    const d = decidir(ctx({ categoria: 'REFERRAL', referidoEmail: null }));

    assert.equal(alta(d), undefined);
    assert.ok(
      d.acciones.some((a) => a.tipo === 'REVISION_HUMANA' && a.bloqueante),
      'tiene que ser bloqueante: sin dirección no hay nada que ejecutar',
    );
  });

  it('un referido @mycompany es un mail mal leído, no un prospect', () => {
    const d = decidir(ctx({ categoria: 'REFERRAL', referidoEmail: 'ally.taylor@mycompany.co' }));

    assert.equal(alta(d), undefined);
    assert.ok(d.acciones.some((a) => a.tipo === 'REVISION_HUMANA' && a.bloqueante));
  });

  it('si dejó la empresa, además da de baja al que escribió', () => {
    // La regla que el SPEC § 6 pedía desde el principio y nunca estuvo
    // implementada: la entidad existía y no la leía nadie.
    const d = decidir(
      ctx({
        categoria: 'REFERRAL',
        emailDelRemitente: 'aturner@northwind.com',
        referidoEmail: 'cpalmer@northwind.com',
        dejoLaEmpresa: true,
      }),
    );

    const baja = d.acciones.find((a) => a.tipo === 'SUBIR_A_DO_NOT_EMAIL') as
      | Extract<Accion, { tipo: 'SUBIR_A_DO_NOT_EMAIL' }>
      | undefined;
    assert.equal(baja?.email, 'aturner@northwind.com', 'la baja es del remitente, no del referido');
    assert.ok(
      d.acciones.some((a) => a.tipo === 'ETIQUETAR' && a.etiqueta === 'UNSUBSCRIBE'),
      'la baja tiene que verse en la casilla',
    );
  });

  it('si NO dejó la empresa, el que escribió sigue en las campañas', () => {
    // Un "no soy yo, hablá con Juan" de alguien que sigue trabajando ahí no es una
    // baja: esa persona puede volver a ser el contacto correcto más adelante.
    const d = decidir(
      ctx({ categoria: 'REFERRAL', referidoEmail: 'otro@acme.com', dejoLaEmpresa: false }),
    );
    assert.ok(!tipos(d.acciones).includes('SUBIR_A_DO_NOT_EMAIL'));
  });
});

describe('NOT_RIGHT_CONTACT: pide el referido y da de baja', () => {
  it('las dos etiquetas, el draft, la baja, y se queda en el inbox', () => {
    const d = decidir(ctx({ categoria: 'NOT_RIGHT_CONTACT' }));

    const etiquetas = d.acciones
      .filter((a): a is Extract<Accion, { tipo: 'ETIQUETAR' }> => a.tipo === 'ETIQUETAR')
      .map((a) => a.etiqueta);
    assert.deepEqual(etiquetas, ['ASK FOR REFERRAL', 'UNSUBSCRIBE']);

    assert.ok(d.acciones.some((a) => a.tipo === 'CREAR_DRAFT' && a.template === 'Ask for referral'));
    assert.ok(tipos(d.acciones).includes('SUBIR_A_DO_NOT_EMAIL'));
    // El draft lo retiene: do-not-email suprime las campañas de Snov, no la
    // respuesta que se manda a mano desde Gmail.
    assert.ok(tipos(d.acciones).includes('DEJAR_EN_INBOX'));
  });

  it('una dirección propia no se da de baja ni acá', () => {
    // La guarda vive en darDeBaja(), así que vale para los cinco caminos que
    // llegan a do-not-email y no depende de que cada rama se acuerde de escribirla.
    const d = decidir(
      ctx({ categoria: 'NOT_RIGHT_CONTACT', emailDelRemitente: 'ally.taylor@mycompany.co' }),
    );
    assert.ok(!tipos(d.acciones).includes('SUBIR_A_DO_NOT_EMAIL'));
    assert.ok(
      d.acciones.some((a) => a.tipo === 'REVISION_HUMANA' && a.motivo.includes('dirección nuestra')),
    );
  });
});

describe('WEBSITE_CONTACT no se automatiza (SPEC § 11)', () => {
  it('no crea nada en el CRM ni en Snov', () => {
    // Cambió respecto de lo que decía el SPEC: estos mails llegan desde @mycompany
    // —los manda el formulario del sitio— así que el prefiltro de dominios propios
    // los descarta antes de clasificarlos. La categoría era inalcanzable y a la vez
    // podía crear un contacto si el clasificador la aplicaba mal.
    const d = decidir(ctx({ categoria: 'WEBSITE_CONTACT' }));

    assert.ok(!tipos(d.acciones).includes('CREAR_LEAD_CRM'));
    assert.ok(!tipos(d.acciones).includes('SUBIR_A_LISTA_SNOV'));
  });

  it('se queda en el inbox para que lo tome una persona', () => {
    const d = decidir(ctx({ categoria: 'WEBSITE_CONTACT' }));
    assert.ok(!tipos(d.acciones).includes('SACAR_DE_INBOX'));
    assert.ok(tipos(d.acciones).includes('DEJAR_EN_INBOX'));
  });

  it('está en NEVER_AUTOMATED, así que siempre va a revisión', () => {
    const d = decidir(ctx({ categoria: 'WEBSITE_CONTACT' }));
    assert.ok(tipos(d.acciones).includes('REVISION_HUMANA'));
  });
});

describe('decidir — ruteo a revisión humana', () => {
  it('la confianza baja manda a revisión', () => {
    const d = decidir(ctx({ confianza: 0.6 }));
    assert.ok(d.acciones.some((a) => a.tipo === 'REVISION_HUMANA' && a.motivo.includes('0.6')));
  });

  it('multi-campaña manda a revisión CON los nombres, no a do-not-email', () => {
    const d = decidir(
      ctx({
        enriquecimiento: {
          ...SIN_PROSPECT,
          esProspect: true,
          campanasQueCuentan: ['KDM - Job Posts (Dice)', 'Forbes 100 Cloud'],
          multiCampana: true,
        },
      }),
    );

    const revision = d.acciones.find((a) => a.tipo === 'REVISION_HUMANA');
    assert.ok(revision?.tipo === 'REVISION_HUMANA' && revision.motivo.includes('KDM - Job Posts'));
    assert.ok(!tipos(d.acciones).includes('SUBIR_A_DO_NOT_EMAIL'), 'nunca automático');
  });

  it('OTHER siempre se revisa y no se saca del inbox', () => {
    const d = decidir(ctx({ categoria: 'OTHER', confianza: 0.99 }));
    assert.ok(tipos(d.acciones).includes('REVISION_HUMANA'));
    assert.ok(!tipos(d.acciones).includes('SACAR_DE_INBOX'));
  });
});

describe('barreraDe — qué flag gobierna cada acción', () => {
  it('subir a una lista pesa como escritura externa, no como un label', () => {
    // La campaña enganchada a la lista manda correos: no es etiquetar.
    assert.equal(
      barreraDe({ tipo: 'SUBIR_A_LISTA_SNOV', listaId: '1', nombreDeLista: 'x' }),
      'externa',
    );
  });

  it('los labels y el archivado son reversibles: barrera de Gmail', () => {
    assert.equal(barreraDe({ tipo: 'ETIQUETAR', etiqueta: 'OOO' }), 'gmail');
    assert.equal(barreraDe({ tipo: 'SACAR_DE_INBOX' }), 'gmail');
  });

  it('lo que no sale del sistema no necesita barrera', () => {
    assert.equal(barreraDe({ tipo: 'REVISION_HUMANA', motivo: 'x', bloqueante: true }), 'ninguna');
  });
});

describe('la etiqueta que dice "no me animé"', () => {
  const tieneMarca = (d: ReturnType<typeof decidir>): boolean =>
    d.acciones.some((a) => a.tipo === 'ETIQUETAR_REVISION' && a.etiqueta === 'BOT - TO CHECK');

  it('la pone cuando la confianza está por debajo del umbral', () => {
    assert.ok(tieneMarca(decidir(ctx({ categoria: 'NO_THANKS', confianza: 0.4 }))));
  });

  it('la pone cuando no se pudo consultar Snov', () => {
    assert.ok(
      tieneMarca(decidir(ctx({ categoria: 'NO_THANKS', enriquecimientoDisponible: false }))),
    );
  });

  it('la pone en OTHER, que no lleva etiqueta propia', () => {
    // Es el caso de "no entendí de qué se trata".
    assert.ok(tieneMarca(decidir(ctx({ categoria: 'OTHER' }))));
  });

  it('NO la pone cuando decidió con confianza', () => {
    assert.ok(!tieneMarca(decidir(ctx({ categoria: 'NO_THANKS', confianza: 0.95 }))));
    assert.ok(!tieneMarca(decidir(ctx({ categoria: 'OOO', confianza: 0.95 }))));
  });

  it('NO la pone en HOT: se revisa siempre, pero el bot sí decidió', () => {
    // HOT tiene revisión no bloqueante y etiqueta propia. Marcarlo además diría
    // algo falso: el bot entendió perfectamente de qué se trata.
    assert.ok(!tieneMarca(decidir(ctx({ categoria: 'HOT', confianza: 0.95 }))));
  });
});

describe('NO_ES_RESPUESTA: la categoría que falla en silencio (SPEC § 12)', () => {
  const marca = (d: ReturnType<typeof decidir>): boolean =>
    d.acciones.some((a) => a.tipo === 'ETIQUETAR_REVISION');

  it('con confianza alta y remitente desconocido, archiva', () => {
    const d = decidir(
      ctx({ categoria: 'NO_ES_RESPUESTA', confianza: 0.96, enriquecimiento: SIN_PROSPECT }),
    );
    assert.equal(d.categoriaFinal, 'NO_ES_RESPUESTA');
    assert.ok(tipos(d.acciones).includes('SACAR_DE_INBOX'));
    assert.ok(!marca(d));
  });

  it('NO archiva si el remitente es un prospect nuestro', () => {
    // Contradicción dura: el clasificador dice "esto no participa del proceso" y
    // Snov dice que le escribimos. Un prospect conocido no es un newsletter.
    const d = decidir(
      ctx({
        categoria: 'NO_ES_RESPUESTA',
        confianza: 0.96,
        enriquecimiento: { ...SIN_PROSPECT, esProspect: true },
      }),
    );

    assert.equal(d.categoriaFinal, 'OTHER');
    assert.ok(!tipos(d.acciones).includes('SACAR_DE_INBOX'), 'se queda en el inbox');
    assert.ok(marca(d));
  });

  it('NO archiva si el remitente ya está en el CRM', () => {
    // La otra mitad de la guarda: Snov responde "¿le escribimos?" y el CRM
    // "¿lo tenemos cargado?". Alcanza con que una diga que sí.
    const d = decidir(
      ctx({
        categoria: 'NO_ES_RESPUESTA',
        confianza: 0.96,
        enriquecimiento: SIN_PROSPECT,
        crm: { existe: true, campana: '🚀 Active in "Q3 Outbound" (Step 2)' },
      }),
    );

    assert.equal(d.categoriaFinal, 'OTHER');
    assert.ok(!tipos(d.acciones).includes('SACAR_DE_INBOX'));
    const rev = d.acciones.find((a) => a.tipo === 'REVISION_HUMANA');
    assert.match(rev?.motivo ?? '', /el CRM/);
    assert.match(rev?.motivo ?? '', /Q3 Outbound/, 'el motivo lleva el contexto de campaña');
  });

  it('NO archiva si no se pudo consultar el CRM', () => {
    // `null` es "no se pudo preguntar", que no es lo mismo que "no está". En
    // cualquier otra categoría daría igual; acá el error no deja rastro.
    const d = decidir(
      ctx({
        categoria: 'NO_ES_RESPUESTA',
        confianza: 0.96,
        enriquecimiento: SIN_PROSPECT,
        crm: { existe: null },
      }),
    );

    assert.equal(d.categoriaFinal, 'OTHER');
    assert.match(
      d.acciones.find((a) => a.tipo === 'REVISION_HUMANA')?.motivo ?? '',
      /no se pudo verificar contra el CRM/,
    );
  });

  it('el CRM caído no frena a las demás categorías', () => {
    // La guarda es específica de NO_ES_RESPUESTA: bloquear todo porque el CRM está
    // caído sería desproporcionado — solo se usa para esta verificación.
    const d = decidir(ctx({ categoria: 'OOO', confianza: 0.95, crm: { existe: null } }));
    assert.equal(d.categoriaFinal, 'OOO');
    assert.ok(tipos(d.acciones).includes('SACAR_DE_INBOX'));
  });

  it('exige más confianza que el umbral normal', () => {
    // 0.85 pasa el CONFIDENCE_THRESHOLD de 0.75 pero no alcanza para archivar como
    // ruido: el costo de equivocarse acá es asimétrico.
    const d = decidir(
      ctx({ categoria: 'NO_ES_RESPUESTA', confianza: 0.85, enriquecimiento: SIN_PROSPECT }),
    );

    assert.equal(d.categoriaFinal, 'OTHER');
    assert.ok(!tipos(d.acciones).includes('SACAR_DE_INBOX'));
    assert.ok(marca(d));
  });

  it('el mismo 0.85 sí alcanza para cualquier otra categoría', () => {
    const d = decidir(ctx({ categoria: 'OOO', confianza: 0.85 }));
    assert.equal(d.categoriaFinal, 'OOO');
    assert.ok(tipos(d.acciones).includes('SACAR_DE_INBOX'));
  });
});

describe('EMAIL_MODIFIED: migra al prospect en vez de solo archivar (SPEC § 7)', () => {
  const subidas = (d: ReturnType<typeof decidir>): Extract<Accion, { tipo: 'SUBIR_A_LISTA_SNOV' }>[] =>
    d.acciones.filter((a): a is Extract<Accion, { tipo: 'SUBIR_A_LISTA_SNOV' }> =>
      a.tipo === 'SUBIR_A_LISTA_SNOV',
    );

  it('sin ser un prospect conocido, no toca Snov: solo etiqueta y archiva', () => {
    const d = decidir(
      ctx({ categoria: 'EMAIL_MODIFIED', enriquecimiento: SIN_PROSPECT, emailNuevo: 'nueva@acme.com' }),
    );

    assert.ok(!tipos(d.acciones).includes('SUBIR_A_LISTA_SNOV'));
    assert.ok(!tipos(d.acciones).includes('SUBIR_A_DO_NOT_EMAIL'));
    assert.ok(tipos(d.acciones).includes('ETIQUETAR'));
    assert.ok(tipos(d.acciones).includes('SACAR_DE_INBOX'));
  });

  it('prospect conocido pero sin dirección nueva extraída: no migra, manda a revisión', () => {
    // Es la misma clase de falla silenciosa que las guardas de NO_ES_RESPUESTA:
    // archivar sin la dirección nueva perdería al prospect sin que nadie se entere.
    const d = decidir(ctx({ categoria: 'EMAIL_MODIFIED', emailNuevo: null }));

    assert.ok(!tipos(d.acciones).includes('SUBIR_A_LISTA_SNOV'));
    assert.ok(!tipos(d.acciones).includes('SUBIR_A_DO_NOT_EMAIL'));
    const rev = d.acciones.find((a) => a.tipo === 'REVISION_HUMANA' && a.bloqueante);
    assert.ok(rev, 'tiene que quedar una revisión bloqueante');
    assert.ok(
      tipos(d.acciones).includes('ETIQUETAR_REVISION'),
      'la marca BOT - TO CHECK tiene que aparecer',
    );
  });

  it('prospect conocido con dirección nueva: sube la NUEVA a cada lista de la vieja', () => {
    const d = decidir(
      ctx({
        categoria: 'EMAIL_MODIFIED',
        emailDelRemitente: 'vieja@acme.com',
        emailNuevo: 'nueva@acme.com',
        enriquecimiento: {
          ...SIN_PROSPECT,
          esProspect: true,
          listas: [
            { id: 111, name: 'Leads - No thanks Ally\'s Inbox' },
            { id: 222, name: 'KDM - Job Posts (Dice)' },
          ],
        },
      }),
    );

    const subidas1 = subidas(d);
    assert.equal(subidas1.length, 2);
    assert.ok(subidas1.every((a) => a.email === 'nueva@acme.com'), 'las dos suben la dirección nueva, no la vieja');
    assert.deepEqual(
      subidas1.map((a) => a.listaId).sort(),
      ['111', '222'],
    );
  });

  it('la dirección VIEJA es la que va a do-not-email, no la nueva', () => {
    const d = decidir(
      ctx({
        categoria: 'EMAIL_MODIFIED',
        emailDelRemitente: 'vieja@acme.com',
        emailNuevo: 'nueva@acme.com',
      }),
    );

    const dne = d.acciones.find((a) => a.tipo === 'SUBIR_A_DO_NOT_EMAIL');
    assert.ok(dne);
    assert.equal((dne as Extract<Accion, { tipo: 'SUBIR_A_DO_NOT_EMAIL' }>).email, 'vieja@acme.com');
  });

  it('y tampoco baja una dirección propia', () => {
    // Este camino a do-not-email se había quedado sin la guarda de dominios propios:
    // el `if` estaba escrito a mano en UNSUBSCRIBE/UNDELIVERABLE y acá no. Es por
    // qué la guarda vive en darDeBaja() y no en cada rama.
    const d = decidir(
      ctx({
        categoria: 'EMAIL_MODIFIED',
        emailDelRemitente: 'ally.taylor@mycompany.co',
        emailNuevo: 'nueva@acme.com',
      }),
    );

    assert.ok(!tipos(d.acciones).includes('SUBIR_A_DO_NOT_EMAIL'));
    assert.ok(
      d.acciones.some((a) => a.tipo === 'REVISION_HUMANA' && a.motivo.includes('dirección nuestra')),
    );
  });

  it('sin listas en Snov, solo manda la vieja a do-not-email', () => {
    const d = decidir(
      ctx({
        categoria: 'EMAIL_MODIFIED',
        emailNuevo: 'nueva@acme.com',
        enriquecimiento: { ...SIN_PROSPECT, esProspect: true, listas: [] },
      }),
    );

    assert.equal(subidas(d).length, 0);
    assert.ok(tipos(d.acciones).includes('SUBIR_A_DO_NOT_EMAIL'));
  });

  it('describir() muestra qué dirección sube a cada lista, para el Sheet', () => {
    const d = decidir(
      ctx({
        categoria: 'EMAIL_MODIFIED',
        emailNuevo: 'nueva@acme.com',
        enriquecimiento: {
          ...SIN_PROSPECT,
          esProspect: true,
          listas: [{ id: 111, name: 'Leads - Referrals' }],
        },
      }),
    );

    const [subida] = subidas(d);
    assert.ok(subida);
    assert.equal(describir(subida), 'subir nueva@acme.com a Snov: Leads - Referrals');
  });

  it('no queda en el inbox cuando la migración se resuelve: se archiva igual', () => {
    const d = decidir(
      ctx({
        categoria: 'EMAIL_MODIFIED',
        emailNuevo: 'nueva@acme.com',
        enriquecimiento: { ...SIN_PROSPECT, esProspect: true, listas: [] },
      }),
    );
    assert.ok(tipos(d.acciones).includes('SACAR_DE_INBOX'));
    assert.ok(!tipos(d.acciones).includes('DEJAR_EN_INBOX'));
  });
});

describe('decidir — modo reproceso (la categoría la decidió una persona)', () => {
  const repro = (over: Partial<ContextoDeDecision> = {}) =>
    decidir(ctx({ modo: 'reproceso', confianza: 1, ...over }));

  it('NOT_NOW: sube a la lista y SE ARCHIVA, sin borrador', () => {
    // El caso que pidió Ally. Sin draft, la regla "todo mail con draft se queda en
    // el inbox" no se dispara y el correo se archiva, que es lo que corresponde
    // cuando ya no hay nada que hacer con él.
    const d = repro({ categoria: 'NOT_NOW' });

    assert.ok(!tipos(d.acciones).includes('CREAR_DRAFT'));
    assert.ok(tipos(d.acciones).includes('SUBIR_A_LISTA_SNOV'));
    assert.ok(tipos(d.acciones).includes('SACAR_DE_INBOX'));
    assert.ok(!tipos(d.acciones).includes('DEJAR_EN_INBOX'));
  });

  it('el draft no se emite y se descarta: no se emite nunca', () => {
    // La diferencia importa. Si se emitiera para filtrarlo después, la regla del
    // inbox vería un draft que no existe y dejaría el correo esperando un borrador
    // que nadie escribió — con REPROCESS ya quitado, o sea invisible.
    for (const categoria of ['NOT_NOW', 'NOT_RIGHT_CONTACT', 'HOT'] as const) {
      const d = repro({ categoria });
      assert.ok(!tipos(d.acciones).includes('CREAR_DRAFT'), `${categoria} no debe dejar draft`);
    }
  });

  it('NOT_RIGHT_CONTACT igual se queda en el inbox, pero por su categoría', () => {
    // Sin draft que lo retenga: lo retiene la lista explícita del handler, porque el
    // pedido de referido lo manda una persona a mano.
    const d = repro({ categoria: 'NOT_RIGHT_CONTACT' });
    assert.ok(!tipos(d.acciones).includes('CREAR_DRAFT'));
    assert.ok(tipos(d.acciones).includes('DEJAR_EN_INBOX'));
  });

  it('no promueve a TO_MANUAL_SORT aunque ya esté en la lista', () => {
    // Si etiquetó NOT NOW sabiendo que ya está en Not now, no hay que corregirla.
    const yaEnNotNow: Enriquecimiento = {
      ...SIN_PROSPECT,
      esProspect: true,
      listas: [{ id: 3000002, name: "Leads - Not now Inbox" }],
    };
    const d = repro({ categoria: 'NOT_NOW', enriquecimiento: yaEnNotNow });
    assert.equal(d.categoriaFinal, 'NOT_NOW');
    assert.equal(d.categoriaBase, null);
  });

  it('NO_ES_RESPUESTA se archiva aunque el remitente esté en Snov', () => {
    // Las guardas del § 12 contrastan al clasificador contra Snov y el CRM. Acá no
    // hay clasificador que contrastar: la persona vio el correo y dijo que es ruido.
    const d = repro({
      categoria: 'NO_ES_RESPUESTA',
      enriquecimiento: { ...SIN_PROSPECT, esProspect: true },
    });
    assert.equal(d.categoriaFinal, 'NO_ES_RESPUESTA');
    assert.ok(tipos(d.acciones).includes('SACAR_DE_INBOX'));
  });

  it('el multi-campaña no vuelve a frenar lo que una persona resolvió', () => {
    const multi: Enriquecimiento = {
      ...SIN_PROSPECT,
      esProspect: true,
      multiCampana: true,
      campanasQueCuentan: ['KDM - Job Posts', 'Otra campaña'],
    };
    const d = repro({ categoria: 'NO_THANKS', enriquecimiento: multi });
    assert.ok(!d.acciones.some((a) => a.tipo === 'REVISION_HUMANA' && a.bloqueante));
    assert.ok(tipos(d.acciones).includes('SUBIR_A_LISTA_SNOV'));
  });

  it('pero Snov caído SÍ frena: es un dato que falta, no un juicio', () => {
    const d = repro({ categoria: 'EMAIL_MODIFIED', enriquecimientoDisponible: false });
    assert.ok(
      d.acciones.some((a) => a.tipo === 'REVISION_HUMANA' && a.bloqueante && a.motivo.includes('Snov')),
    );
  });
});

describe('decidir — la baja pedida con la etiqueta UNSUBSCRIBE', () => {
  const repro = (over: Partial<ContextoDeDecision> = {}) =>
    decidir(ctx({ modo: 'reproceso', confianza: 1, bajaPedidaPorEtiqueta: true, ...over }));

  it('NOT NOW DRIP + UNSUBSCRIBE: sube a la lista y además da de baja', () => {
    const d = repro({ categoria: 'NOT_NOW' });
    assert.ok(tipos(d.acciones).includes('SUBIR_A_LISTA_SNOV'));
    assert.ok(tipos(d.acciones).includes('SUBIR_A_DO_NOT_EMAIL'));
    assert.ok(d.acciones.some((a) => a.tipo === 'ETIQUETAR' && a.etiqueta === 'UNSUBSCRIBE'));
  });

  it('no duplica la baja cuando la categoría ya la traía', () => {
    // ASK FOR REFERRAL ya da de baja por su cuenta. Dos SUBIR_A_DO_NOT_EMAIL de la
    // misma dirección no rompen nada en Snov, pero el log mostraría dos bajas donde
    // hubo una y eso después no se puede auditar.
    const d = repro({ categoria: 'NOT_RIGHT_CONTACT' });
    const bajas = d.acciones.filter((a) => a.tipo === 'SUBIR_A_DO_NOT_EMAIL');
    assert.equal(bajas.length, 1);
    const etiquetas = d.acciones.filter(
      (a) => a.tipo === 'ETIQUETAR' && a.etiqueta === 'UNSUBSCRIBE',
    );
    assert.equal(etiquetas.length, 1);
  });

  it('una dirección propia no se da de baja ni pedido a mano', () => {
    // La barrera no se abre etiquetando un mail: una persona puede corregir un
    // juicio del bot, no desactivar una regla dura.
    const d = repro({ categoria: 'NOT_NOW', emailDelRemitente: 'ally.taylor@mycompany.co' });
    assert.ok(!tipos(d.acciones).includes('SUBIR_A_DO_NOT_EMAIL'));
    assert.ok(
      d.acciones.some((a) => a.tipo === 'REVISION_HUMANA' && a.motivo.includes('dirección nuestra')),
    );
  });
});
