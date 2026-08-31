import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  asuntoDeRespuesta,
  esNombreDePlantilla,
  normalizarNombre,
  primerNombre,
  renderizar,
  SIN_DATO,
} from './plantillas.js';

describe('primerNombre', () => {
  it('el formato normal', () => {
    assert.equal(primerNombre('Kyle Anzalone'), 'Kyle');
  });

  it('"Apellido, Nombre" toma el de después de la coma', () => {
    // El caso menos obvio y el que más aparece: lo usa Outlook corporativo.
    // Partir por espacios sin mirar la coma saludaría "Hi Maar," a Christian.
    assert.equal(primerNombre('Maar, Christian'), 'Christian');
    assert.equal(primerNombre('Hudson, Joan'), 'Joan');
  });

  it('un solo token en MAYÚSCULAS es el apellido, vaya adelante o atrás', () => {
    // Convención francesa, suiza y de varios países del este. Se detectó tarde:
    // un EMAIL_MODIFIED real subió a Snov `firstName: "VOZENIN"` —el apellido— y
    // las campañas saludan con {{first_name}}.
    assert.equal(primerNombre('VOZENIN Marie-Catherine'), 'Marie-Catherine');
    assert.equal(primerNombre('JUCHA Jozef'), 'Jozef');
    assert.equal(primerNombre('Michael BLANK'), 'Michael');
  });

  it('con todo en mayúsculas no hay señal: toma el primero', () => {
    // Sin un token que se distinga, cualquier elección sería adivinar. Sale
    // capitalizado igual: el saludo no puede gritar aunque el header grite.
    assert.equal(primerNombre('JOHN SMITH'), 'John');
  });

  it('la coma gana sobre las mayúsculas', () => {
    assert.equal(primerNombre('VOZENIN, Marie-Catherine'), 'Marie-Catherine');
  });

  it('devuelve el nombre capitalizado, venga como venga', () => {
    // Va al saludo del draft y al firstName de Snov: "Hi MARIE-CATHERINE" grita y
    // "Hi jozef" se lee descuidado. Los dos llegan así desde headers reales.
    assert.equal(primerNombre('MARIE-CATHERINE VOZENIN'), 'Marie-Catherine');
    assert.equal(primerNombre('jozef jucha'), 'Jozef');
  });

  it('descarta la empresa después del pipe', () => {
    assert.equal(primerNombre('Jan de Vries | PlantCo'), 'Jan');
  });

  it('descarta el sufijo entre paréntesis', () => {
    assert.equal(primerNombre('Kyle Anzalone (Leaver)'), 'Kyle');
    assert.equal(primerNombre('Gibbons, Bruce (BCIT)'), 'Bruce');
  });

  it('sin nombre utilizable devuelve undefined', () => {
    for (const v of [null, '', '   ', 'lead@empresa.com', '123', ',']) {
      assert.equal(primerNombre(v), undefined, JSON.stringify(v));
    }
  });

  it('aguanta acentos y caracteres no ASCII', () => {
    assert.equal(primerNombre('Müller, Jörg'), 'Jörg');
    assert.equal(primerNombre('Zuzanna Schmidt'), 'Zuzanna');
  });
});

describe('renderizar', () => {
  it('pone el nombre', () => {
    assert.match(renderizar('Ask for referral', { nombre: 'Christian' }), /^Hi Christian,/);
  });

  it('sin nombre deja XXX, que es lo que deja Ally', () => {
    // Un "Hi there" taparía el hueco y haría más probable que se mande sin
    // corregir. El XXX se ve.
    assert.match(renderizar('Ask for referral'), /^Hi XXX,/);
    assert.equal(SIN_DATO, 'XXX');
  });

  it('la de HOT tiene dos variables', () => {
    const t = renderizar('Position details HOT', { nombre: 'Joan' });
    assert.match(t, /^Hi Joan,/);
    // El clasificador no extrae la tecnología: queda visible para que la complete
    // quien revisa.
    assert.match(t, /experienced XXX developers/);
  });

  it('no lleva firma: la agrega Gmail', () => {
    for (const p of ['Cold last try', 'Ask for referral', 'Position details HOT'] as const) {
      const t = renderizar(p, { nombre: 'X' });
      assert.ok(t.trimEnd().endsWith('Ally'), p);
      assert.ok(!t.includes('Global Development Manager'), `${p} no repite la firma`);
    }
  });

  it('la presentación va como link, no como adjunto', () => {
    // El draft no lleva adjuntos: un PDF repetido en cada uno engorda la casilla,
    // y el link se actualiza sin tocar el bot.
    const t = renderizar('Cold last try');
    assert.match(t, /https:\/\/mycompany\.co\/brochure\/MyCompany_Presentation\.pdf/);
    assert.ok(!/attached/i.test(t), 'no puede decir "attached" si no adjunta nada');
  });

  it('los textos son los de Ally, no una reescritura', () => {
    assert.match(renderizar('Cold last try'), /Many thanks for your response\./);
    assert.match(renderizar('Ask for referral'), /connect me to the person who is in charge/);
    assert.match(renderizar('Position details HOT'), /Type of assignment \(part or full-time\)/);
  });
});

describe('esNombreDePlantilla', () => {
  it('reconoce las tres', () => {
    for (const p of ['Cold last try', 'Ask for referral', 'Position details HOT']) {
      assert.ok(esNombreDePlantilla(p), p);
    }
  });

  it('rechaza una que no existe', () => {
    // Sustituirla por otra o saltearla mandaría el texto equivocado sin aviso.
    assert.equal(esNombreDePlantilla('Cold Last Try'), false);
    assert.equal(esNombreDePlantilla('inventada'), false);
  });
});

describe('asuntoDeRespuesta', () => {
  it('agrega Re: al original', () => {
    assert.equal(asuntoDeRespuesta('About your Security Architect role'), 'Re: About your Security Architect role');
  });

  it('no duplica el Re: si ya venía', () => {
    assert.equal(asuntoDeRespuesta('Re: About your role'), 'Re: About your role');
    assert.equal(asuntoDeRespuesta('RE: About your role'), 'RE: About your role');
  });

  it('sin asunto no arma uno inventado', () => {
    assert.equal(asuntoDeRespuesta(null), 'Re:');
  });
});

describe('normalizarNombre', () => {
  it('mayúsculas y minúsculas van a "Primera en mayúscula"', () => {
    assert.equal(normalizarNombre('MARIE-CATHERINE'), 'Marie-Catherine');
    assert.equal(normalizarNombre('ANNE-SOPHIE'), 'Anne-Sophie');
    assert.equal(normalizarNombre('jozef'), 'Jozef');
  });

  it('no toca lo que ya tiene mayúsculas intercaladas', () => {
    // Alguien lo escribió así a propósito; normalizarlo daría "Mcdonald".
    for (const n of ['McDonald', "O'Brien", 'van Nood', 'DeAngelo']) {
      assert.equal(normalizarNombre(n), n);
    }
  });

  it('respeta los acentos', () => {
    assert.equal(normalizarNombre('JOSÉ'), 'José');
    assert.equal(normalizarNombre('josé'), 'José');
  });
});
