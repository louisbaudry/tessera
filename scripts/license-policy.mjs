/**
 * The license policy for what Tessera ships (issue #259,
 * `planning/prior-art.md`): which SPDX licenses a production dependency may
 * carry, and the one place an exception is recorded with its reason.
 *
 * Pure: no I/O, so `license-policy.test.ts` proves it, and
 * `check-licenses.mjs` is the only caller that reads `pnpm licenses`.
 */

/**
 * Permissive licenses accepted without a decision. A copyleft or weak-copyleft
 * license (GPL, AGPL, LGPL, MPL, EPL), a source-available one, `UNLICENSED`
 * and a missing license are all absent on purpose: each needs a person to look
 * at it, which is what {@link EXCEPTIONS} records.
 */
export const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Unlicense',
  'WTFPL',
]);

/**
 * A package accepted despite a license outside {@link ALLOWED}, by exact name.
 * Each value says why, so the exception is a decision on the record and not a
 * silenced check. Empty today.
 *
 * @type {Record<string, string>}
 */
export const EXCEPTIONS = {};

/**
 * Whether an SPDX license expression is acceptable: `A OR B` when either side
 * is, `A AND B` only when both are, parentheses honoured. A `WITH` exception
 * clause, an unknown identifier and an empty string are not acceptable, so an
 * expression this parser does not understand fails closed.
 *
 * @param {string} expression An SPDX expression, e.g. `(MIT OR WTFPL)`.
 * @returns {boolean}
 */
export function licenseAllowed(expression) {
  const tokens = String(expression ?? '').match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;

  // or := and ('OR' and)*   and := atom ('AND' atom)*   atom := '(' or ')' | id
  // Both sides of an OR are parsed even after one is known good, so the
  // cursor always ends at the end of a well-formed expression.
  const parseOr = () => {
    let ok = parseAnd();
    while (tokens[at]?.toUpperCase() === 'OR') {
      at += 1;
      const right = parseAnd();
      ok = ok || right;
    }
    return ok;
  };
  const parseAnd = () => {
    let ok = parseAtom();
    while (tokens[at]?.toUpperCase() === 'AND') {
      at += 1;
      const right = parseAtom();
      ok = ok && right;
    }
    return ok;
  };
  const parseAtom = () => {
    const token = tokens[at];
    if (token === undefined) throw new Error('unexpected end');
    at += 1;
    if (token === '(') {
      const ok = parseOr();
      if (tokens[at] !== ')') throw new Error('missing )');
      at += 1;
      return ok;
    }
    if (token === ')') throw new Error('unexpected )');
    // A trailing `+` ("or later") is part of the identifier and not in the
    // allowlist, so it stays refused rather than being quietly stripped.
    return ALLOWED.has(token);
  };

  try {
    const ok = parseOr();
    return at === tokens.length && ok;
  } catch {
    return false;
  }
}

/**
 * One package a license check refused.
 *
 * @typedef {{ name: string, versions: string[], license: string }} Violation
 */

/**
 * Applies the policy to the JSON `pnpm licenses list --json` prints: an object
 * keyed by license expression, each value a list of packages.
 *
 * @param {Record<string, Array<{ name: string, versions?: string[] }>>} report
 * @returns {Violation[]} Packages whose license is not allowed and that have
 *   no entry in {@link EXCEPTIONS}; empty when the policy holds.
 */
export function checkLicenses(report) {
  /** @type {Violation[]} */
  const violations = [];
  for (const [license, packages] of Object.entries(report)) {
    if (licenseAllowed(license)) continue;
    for (const pkg of packages) {
      if (Object.hasOwn(EXCEPTIONS, pkg.name)) continue;
      violations.push({
        name: pkg.name,
        versions: pkg.versions ?? [],
        license,
      });
    }
  }
  return violations;
}
