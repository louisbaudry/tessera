/**
 * The pre-translate fuzzy threshold's input (`v1-spec.md` §6.1a, 2; issue
 * #139): what a person typed, as the choice the server takes. Pure, so the
 * range is proved without a DOM; the range itself comes from the server
 * (`min`, `max`), never a second copy of the scorer's constants here.
 */

/** What the server returns and accepts: a score, `null` for off. */
export interface FuzzyThresholdView {
  readonly threshold: number | null;
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

export type ThresholdChoice =
  | { readonly ok: true; readonly choice: number | null | 'default' }
  | { readonly ok: false; readonly message: string };

/**
 * `text` is the number field, `off` the checkbox. Off wins over any text; an
 * empty field means the default again; anything else must be a whole number in
 * range.
 */
export function thresholdChoice(
  text: string,
  off: boolean,
  range: { readonly min: number; readonly max: number },
): ThresholdChoice {
  if (off) return { ok: true, choice: null };
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, choice: 'default' };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < range.min || n > range.max) {
    return {
      ok: false,
      message: `Use a whole number from ${range.min} to ${range.max}, or switch fuzzy off.`,
    };
  }
  return { ok: true, choice: n };
}

/** The field's text for a threshold in force: empty when off, the score otherwise. */
export function thresholdText(view: Pick<FuzzyThresholdView, 'threshold'>): string {
  return view.threshold === null ? '' : String(view.threshold);
}
