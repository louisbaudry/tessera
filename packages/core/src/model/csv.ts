/**
 * One CSV cell, safe to open in a spreadsheet (RFC 4180 quoting).
 *
 * A spreadsheet runs a cell that starts with `=`, `+`, `-`, `@`, a tab or a
 * carriage return as a formula, so a free-text cell that begins with one is
 * prefixed with `'`. Defined once here, in the browser-safe `model/` layer,
 * because every CSV this product writes holds text a person typed (a vendor
 * label, a glossary term): the vendor ledger and the client glossary export
 * both import it, and a second copy could drift from the first.
 */

/** What makes a spreadsheet read a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** `text` as one CSV cell: neutralised against formula injection, quoted when it needs it. */
export function csvCell(text: string): string {
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
