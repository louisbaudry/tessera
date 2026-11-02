/**
 * What a currency is (issue #327, `planning/standards-register.md` §2): an ISO 4217 code
 * the runtime's own currency list knows. One definition for every place that stores or
 * shows money, so a portal setting and, later, the vendor ledger accept the same codes.
 *
 * The list is `Intl.supportedValuesOf('currency')`, the ICU data the runtime formats with,
 * rather than a table copied here: a code it does not know is one `Intl.NumberFormat` could
 * not show a symbol for anyway, and a copied table would be a second definition of a list
 * ISO maintains. `Intl.NumberFormat` itself is not the check, because it accepts any three
 * letters (`XYZ`) and prints them as the symbol.
 */

let known: ReadonlySet<string> | undefined;

/**
 * Whether `code` is an ISO 4217 currency code, written as ISO writes it (three upper-case
 * letters, `EUR`, never `eur`).
 *
 * @param code - The text to check.
 * @returns `true` for a code the runtime's currency list holds.
 */
export function isCurrencyCode(code: string): boolean {
  known ??= new Set(Intl.supportedValuesOf('currency'));
  return /^[A-Z]{3}$/.test(code) && known.has(code);
}
