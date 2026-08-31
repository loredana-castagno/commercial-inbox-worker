import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { esLaMismaCuenta } from './auth.js';

describe('esLaMismaCuenta', () => {
  it('acepta la misma casilla con distinta capitalización', () => {
    assert.equal(esLaMismaCuenta('Ally.Taylor@mycompany.co', 'ally.taylor@mycompany.co'), true);
    assert.equal(esLaMismaCuenta('  ally.taylor@mycompany.co  ', 'ally.taylor@mycompany.co'), true);
  });

  it('rechaza otra casilla del mismo dominio', () => {
    assert.equal(
      esLaMismaCuenta('loredana.castagno@mycompany.co', 'ally.taylor@mycompany.co'),
      false,
      'el click de más en el selector de Google es justo este caso',
    );
  });

  it('rechaza la misma parte local en otro dominio', () => {
    assert.equal(esLaMismaCuenta('ally.taylor@gmail.com', 'ally.taylor@mycompany.co'), false);
  });

  it('rechaza una casilla vacía, que es lo que llega si Gmail no devuelve la dirección', () => {
    assert.equal(esLaMismaCuenta('', 'ally.taylor@mycompany.co'), false);
  });

  it('rechaza los alias con punto: en Workspace pueden ser buzones distintos', () => {
    assert.equal(esLaMismaCuenta('allytaylor@mycompany.co', 'ally.taylor@mycompany.co'), false);
  });
});
