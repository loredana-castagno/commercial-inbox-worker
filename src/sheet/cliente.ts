import { google, type sheets_v4 } from 'googleapis';
import { ejecutarConRetry } from '../retry.js';

/**
 * Cliente de Google Sheets: **el único camino por el que se escribe en el log**.
 *
 * Igual que `GmailClient`, la instancia de `googleapis` es privada: no hay forma
 * de escribir en el Sheet sin pasar por el retry de acá (CLAUDE.md #6).
 *
 * El alcance está deliberadamente acotado a *agregar filas*. No expone borrado ni
 * edición: el log es un registro append-only, y una corrida del worker no tiene
 * por qué poder pisar lo que escribió la anterior.
 */

/** Solo `spreadsheets`. Nada de Drive: no necesita listar ni crear archivos. */
export const SCOPE_SHEETS = 'https://www.googleapis.com/auth/spreadsheets';

export interface CredencialDeServicio {
  readonly client_email: string;
  readonly private_key: string;
}

export class SheetClient {
  readonly #sheets: sheets_v4.Sheets;
  readonly #spreadsheetId: string;

  constructor(credencial: CredencialDeServicio, spreadsheetId: string) {
    const auth = new google.auth.JWT({
      email: credencial.client_email,
      key: credencial.private_key,
      scopes: [SCOPE_SHEETS],
    });
    this.#sheets = google.sheets({ version: 'v4', auth });
    this.#spreadsheetId = spreadsheetId;
  }

  /** Títulos de las pestañas que ya existen. */
  async pestañas(): Promise<string[]> {
    const meta = await ejecutarConRetry(() =>
      this.#sheets.spreadsheets.get({ spreadsheetId: this.#spreadsheetId }),
    );
    return (meta.data.sheets ?? [])
      .map((h) => h.properties?.title)
      .filter((t): t is string => typeof t === 'string');
  }

  async crearPestaña(titulo: string): Promise<void> {
    await ejecutarConRetry(() =>
      this.#sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.#spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: titulo } } }] },
      }),
    );
  }

  /** Cuántas filas tiene ocupadas la pestaña, contando el encabezado. */
  async filasOcupadas(pestaña: string): Promise<number> {
    const r = await ejecutarConRetry(() =>
      this.#sheets.spreadsheets.values.get({
        spreadsheetId: this.#spreadsheetId,
        range: `${pestaña}!A:A`,
      }),
    );
    return (r.data.values ?? []).length;
  }

  /**
   * Agrega filas al final.
   *
   * `INSERT_ROWS` hace que la hoja crezca sola cuando se llena la grilla, en vez
   * de sobrescribir lo que haya debajo. `RAW` evita que Sheets reinterprete el
   * contenido: un asunto que empieza con `=` o con `+` es texto, no una fórmula.
   */
  async agregarFilas(pestaña: string, filas: readonly (readonly string[])[]): Promise<void> {
    if (filas.length === 0) return;

    await ejecutarConRetry(() =>
      this.#sheets.spreadsheets.values.append({
        spreadsheetId: this.#spreadsheetId,
        range: `${pestaña}!A:A`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: filas as string[][] },
      }),
    );
  }

  /** Congela el encabezado y lo pone en negrita. Cosmético, se hace una sola vez. */
  async formatearEncabezado(pestaña: string): Promise<void> {
    const meta = await ejecutarConRetry(() =>
      this.#sheets.spreadsheets.get({ spreadsheetId: this.#spreadsheetId }),
    );
    const hoja = (meta.data.sheets ?? []).find((h) => h.properties?.title === pestaña);
    const sheetId = hoja?.properties?.sheetId;
    if (sheetId === undefined || sheetId === null) return;

    await ejecutarConRetry(() =>
      this.#sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.#spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                fields: 'gridProperties.frozenRowCount',
              },
            },
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                cell: { userEnteredFormat: { textFormat: { bold: true } } },
                fields: 'userEnteredFormat.textFormat.bold',
              },
            },
          ],
        },
      }),
    );
  }
}
