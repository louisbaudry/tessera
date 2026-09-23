/**
 * Numeral extraction and locale-aware comparison for `num.missing` and
 * `num.altered` (backlog #24; `planning/v1-spec.md` §6.4).
 *
 * The one thing these rules must never do is fire on a correctly
 * localised number — `1,000.50` in English *is* `1 000,50` in French and
 * `1.000,50` in German, and a rule that flags that gets switched off,
 * taking the real findings with it. So a numeral is compared three ways,
 * most to least strict, and only the last resort is a finding:
 *
 * 1. **Surface** — the same characters. A number copied verbatim is never
 *    reported, even where the target locale would write it differently:
 *    that is a localisation nicety, not an altered number, and the false
 *    positives on version numbers, codes and dates would drown the rest.
 * 2. **Value** — the same number once each side is read under its *own*
 *    locale's grouping and decimal conventions. This is what makes the
 *    three renderings above equal.
 * 3. **Digits** — the same digit string with every separator removed.
 *    Present but not readable as the same value under the target locale
 *    means the separators were changed to something that locale does not
 *    write — `1,000` → `1 000` in an English target — and that is
 *    `num.altered`.
 *
 * Every match consumes its target numeral, so two `10`s in the source
 * need two in the target. What is left gets one last, non-consuming look
 * — **components** — before it is `num.missing`: a numeral the locale
 * could not read as one number (`12.03.2025`, `3.2.1`) is a sequence of
 * digit groups, and a source numeral whose groups all appear among the
 * target's groups is accounted for. This is what keeps a date from
 * firing three times: English `03/12/2025` is three numerals, German
 * `12.03.2025` is one unreadable one, and its groups are the answer.
 */

import { GROUPING_SPACES, type NumberFormat } from './locale.js';

export interface Numeral {
  /** As written, separators included. */
  readonly surface: string;
  /** Every digit, no separators. */
  readonly digits: string;
  /** The digit groups between separators, leading zeros stripped. */
  readonly groups: readonly string[];
  /**
   * Canonical value under the locale it was read with — integer part
   * without leading zeros, then `.` and the fraction verbatim when there
   * is one — or `null` when the separators do not parse as one number in
   * that locale (`3.2.1`, `1,00` in English, `1.000` in French).
   */
  readonly value: string | null;
}

const SPACE_CLASS = `[${GROUPING_SPACES.join('')}]`;

/**
 * Two shapes, tried in this order:
 *
 * - **Space-grouped**: one to three digits, then groups of exactly three
 *   digits each after a space, then an optional `.`/`,` fraction. Exactly
 *   three, and not followed by a fourth digit, so `call 555 1234` is two
 *   numerals and `In 2024 500 people` is `2024` and `500` — a leading
 *   group of four can never be a thousands group.
 * - **Punctuation-grouped**: digits joined by single `.` `,` `'` `’`
 *   characters, with no length constraint on the groups. This deliberately
 *   swallows `3.2.1` and `12,5` whole: the locale reading decides whether
 *   they are numbers, and a version string the target keeps verbatim
 *   matches by surface either way.
 *
 * ASCII digits only: `\d` is ASCII under the `u` flag, and none of the
 * seven languages writes numbers in another script.
 */
const NUMERAL_PATTERN = new RegExp(
  `\\d{1,3}(?:${SPACE_CLASS}\\d{3}(?!\\d))+(?:[.,]\\d+)?|\\d+(?:[.,'\\u2019]\\d+)*`,
  'gu',
);

const stripLeadingZeros = (digits: string): string => digits.replace(/^0+(?=\d)/, '');

/**
 * Reads one numeral under a locale's conventions. `null` for anything
 * the locale would not write as a single number — see {@link Numeral}.
 */
export function canonicalValue(surface: string, format: NumberFormat): string | null {
  const parts = surface.split(/(\D)/u);
  const groups = parts.filter((_, i) => i % 2 === 0);
  const separators = parts.filter((_, i) => i % 2 === 1);
  if (separators.length === 0) return stripLeadingZeros(groups[0]!);

  const first = groups[0]!;
  const last = separators[separators.length - 1]!;
  const isGrouped = (seps: readonly string[], grouped: readonly string[]): boolean =>
    seps.every((s) => format.grouping.has(s)) &&
    grouped.every((g) => g.length === 3) &&
    first.length <= 3;

  // Thousands separators only: `1,000,000` in English, `1.000.000` in German.
  if (isGrouped(separators, groups.slice(1))) return stripLeadingZeros(groups.join(''));

  // A decimal separator last, with any thousands separators before it.
  if (format.decimal !== null && last === format.decimal) {
    const integerGroups = groups.slice(0, -1);
    const fraction = groups[groups.length - 1]!;
    if (separators.length === 1) {
      return `${stripLeadingZeros(first)}.${fraction}`;
    }
    if (isGrouped(separators.slice(0, -1), integerGroups.slice(1))) {
      return `${stripLeadingZeros(integerGroups.join(''))}.${fraction}`;
    }
  }
  return null;
}

/** Every numeral in `text`, in order, read under `format`. */
export function extractNumerals(text: string, format: NumberFormat): Numeral[] {
  const out: Numeral[] = [];
  for (const match of text.matchAll(NUMERAL_PATTERN)) {
    const surface = match[0];
    out.push({
      surface,
      digits: surface.replace(/\D/gu, ''),
      groups: surface.split(/\D/u).map(stripLeadingZeros),
      value: canonicalValue(surface, format),
    });
  }
  return out;
}

export interface NumeralComparison {
  /** Source numerals with no counterpart in the target by any of the three readings. */
  readonly missing: readonly Numeral[];
  /** Source numerals found in the target by digits only — reformatted the way the target locale does not write. */
  readonly altered: readonly { readonly from: Numeral; readonly to: Numeral }[];
}

/**
 * Pairs source numerals with target numerals — surface first, then value,
 * then digits — each target numeral consumed by at most one source
 * numeral; then the non-consuming component pass described above. Extra
 * target numerals are not reported; the spec has no `num.extra`.
 */
export function compareNumerals(
  source: readonly Numeral[],
  target: readonly Numeral[],
): NumeralComparison {
  const used = new Array<boolean>(target.length).fill(false);
  const matched = new Array<Numeral | null>(source.length).fill(null);
  const altered: { from: Numeral; to: Numeral }[] = [];

  const pass = (
    equal: (s: Numeral, t: Numeral) => boolean,
    onMatch?: (s: Numeral, t: Numeral) => void,
  ): void => {
    source.forEach((s, i) => {
      if (matched[i] !== null) return;
      const j = target.findIndex((t, k) => !used[k] && equal(s, t));
      if (j === -1) return;
      used[j] = true;
      matched[i] = target[j]!;
      onMatch?.(s, target[j]!);
    });
  };

  pass((s, t) => s.surface === t.surface);
  pass((s, t) => s.value !== null && s.value === t.value);
  pass(
    (s, t) => s.digits === t.digits,
    (from, to) => altered.push({ from, to }),
  );

  // Components: every digit group of every still-unconsumed target
  // numeral, plus each one whole. A source numeral the locale could read
  // is one group (its digits); one it could not is its groups, each of
  // which must be found. Not consuming, so one date serves every source
  // numeral it contains.
  const pool = new Set<string>();
  target.forEach((t, k) => {
    if (used[k]) return;
    pool.add(stripLeadingZeros(t.digits));
    if (t.value === null) for (const g of t.groups) pool.add(g);
  });
  const components = (n: Numeral): readonly string[] =>
    n.value === null ? n.groups : [stripLeadingZeros(n.digits)];

  return {
    missing: source.filter(
      (s, i) => matched[i] === null && !components(s).every((g) => pool.has(g)),
    ),
    altered,
  };
}
