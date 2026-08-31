import { instalarManejadorDeErrores } from '../cli-errores.js';
import { loadGmailEnv } from '../config.js';
import { crearClienteAutenticado, preflightDeCredenciales } from '../gmail/auth.js';
import { GmailClient } from '../gmail/client.js';
import { ETIQUETAS, resolverEtiquetas } from '../gmail/etiquetas-del-dataset.js';
import { parsearMensaje, type MensajeParseado } from '../gmail/parse.js';

/**
 * Test de regresión del stripping contra mails reales.
 *
 * No afirma que el resultado sea correcto — eso lo dice el ojo humano en
 * `gmail:peek`. Lo que hace es fijar la distribución de cortes por etiqueta, para
 * que cuando se toque un marcador de `strip-quoted.ts` se vea si mejoró o rompió.
 * Un marcador que deja de matchear se ve como "nada" creciendo.
 *
 *   npm run gmail:audit              # tabla legible
 *   npm run gmail:audit -- --json    # para diffear entre corridas
 *   npm run gmail:audit -- 20        # cuántos mensajes por etiqueta
 *
 * Solo lectura: no toca la base ni Gmail.
 */

const args = process.argv.slice(2);
const porEtiqueta = Number(args.find((a) => /^\d+$/.test(a)) ?? '10');
const comoJson = args.includes('--json');

instalarManejadorDeErrores();
const config = loadGmailEnv();
const auth = crearClienteAutenticado(config);
const client = new GmailClient(auth, { scopeConfigurado: config.GMAIL_SCOPE });
await preflightDeCredenciales(auth, client, config);

const mapa = await resolverEtiquetas(client);

interface FilaDeAudit {
  etiqueta: string;
  revisados: number;
  cortes: Record<string, number>;
  /** Cuerpo mínimo con crudo largo. Suele ser legítimo ("No thanks."), se revisa a ojo. */
  cuerposMinimos: number;
  /** Rastros de citado que sobrevivieron: esto sí es un marcador que falló. */
  citadoSobrante: number;
  vacios: number;
}

const filas: FilaDeAudit[] = [];
const alias = new Map<string, number>();

/** Rastros estructurales, no la palabra "mycompany" — que aparece en pies de página. */
function tieneCitadoSobrante(m: MensajeParseado): boolean {
  return (
    /^\s*>/m.test(m.cuerpo) ||
    /\bwrote:\s*$/im.test(m.cuerpo) ||
    /^(From|De|Sent|Enviado):\s/im.test(m.cuerpo)
  );
}

for (const { nombre } of ETIQUETAS) {
  const etiqueta = mapa.get(nombre.toUpperCase());
  if (etiqueta === undefined) {
    filas.push({
      etiqueta: nombre,
      revisados: 0,
      cortes: {},
      cuerposMinimos: 0,
      citadoSobrante: 0,
      vacios: 0,
    });
    continue;
  }

  const lista = await client.listarMensajes({
    labelIds: [etiqueta.id],
    maxResults: porEtiqueta,
  });

  const fila: FilaDeAudit = {
    etiqueta: nombre,
    revisados: 0,
    cortes: {},
    cuerposMinimos: 0,
    citadoSobrante: 0,
    vacios: 0,
  };

  for (const { id } of lista.messages ?? []) {
    const m = parsearMensaje(await client.obtenerMensaje(id));
    fila.revisados += 1;

    const marca = m.limpieza.cortadoPor ?? 'nada';
    fila.cortes[marca] = (fila.cortes[marca] ?? 0) + 1;

    if (m.cuerpo.trim() === '') fila.vacios += 1;
    else if (m.cuerpo.trim().length < 15 && m.cuerpoCrudo.trim().length > 150) {
      fila.cuerposMinimos += 1;
    }
    if (tieneCitadoSobrante(m)) fila.citadoSobrante += 1;

    for (const d of [...m.to.map((x) => x.email), ...m.deliveredTo]) {
      if (/@mycompany\./i.test(d)) alias.set(d.toLowerCase(), (alias.get(d.toLowerCase()) ?? 0) + 1);
    }
  }

  filas.push(fila);
}

if (comoJson) {
  console.log(
    JSON.stringify({ porEtiqueta, filas, alias: Object.fromEntries(alias) }, null, 2),
  );
} else {
  console.log(`\nAuditoría del stripping — ${porEtiqueta} mensajes por etiqueta\n`);
  console.log(
    'etiqueta'.padEnd(18) +
      'rev'.padStart(5) +
      '  cortes'.padEnd(42) +
      'mínimos'.padStart(8) +
      'sobrante'.padStart(9) +
      'vacíos'.padStart(7),
  );
  console.log('─'.repeat(96));

  for (const f of filas) {
    if (f.revisados === 0) {
      console.log(`${f.etiqueta.padEnd(18)}${'sin mensajes o no existe'.padStart(9)}`);
      continue;
    }
    const cortes = Object.entries(f.cortes)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    console.log(
      f.etiqueta.padEnd(18) +
        String(f.revisados).padStart(5) +
        '  ' +
        cortes.padEnd(40) +
        String(f.cuerposMinimos).padStart(8) +
        String(f.citadoSobrante).padStart(9) +
        String(f.vacios).padStart(7),
    );
  }

  console.log('\nalias de MyCompany vistos (To / Delivered-To):');
  for (const [d, n] of [...alias.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${d}`);
  }
  console.log(
    '\n"mínimos" casi siempre es legítimo: la respuesta real era "No thanks.".' +
      '\n"sobrante" es el que importa: un marcador que no matcheó.',
  );
}
