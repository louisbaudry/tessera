/**
 * The vocabulary of a vendor's profile and rate card (`planning/vendor-spec.md`
 * §5 and its #46 implementation note). Pure: the closed sets a `.ctv`
 * freezes into its `CHECK`s as literals (`db/migrate.ts`, backlog #64), and
 * the one normalisation of a free-form tag.
 */

/**
 * What a rate is set for: the match tier of a segment's TM result
 * (decision 9). **Provisional**: decision 9 names "fuzzy bands" without
 * naming them, and fuzzy matching and its bands are `#61`'s. These are the
 * conventional ones until it decides; changing them is a migration that
 * rebuilds `rate_card_entry`, with a mapping for the rows already there.
 */
export const RATE_TIERS = [
  'no_match',
  'fuzzy_50_74',
  'fuzzy_75_84',
  'fuzzy_85_94',
  'fuzzy_95_99',
  /** 100% matches and repetitions. */
  'exact',
  /** 101%: same sentence, same context. */
  'ice',
] as const;
export type RateTier = (typeof RATE_TIERS)[number];

export const isRateTier = (value: unknown): value is RateTier =>
  (RATE_TIERS as readonly unknown[]).includes(value);

/** A vendor-set toggle (decision 8): what the owner reads before offering work. */
export const CAPACITY_STATUSES = ['available', 'busy', 'away'] as const;
export type CapacityStatus = (typeof CAPACITY_STATUSES)[number];

export const isCapacityStatus = (value: unknown): value is CapacityStatus =>
  (CAPACITY_STATUSES as readonly unknown[]).includes(value);

/** A specialty tag as stored: trimmed, lower-cased, inner whitespace collapsed. Empty if nothing is left. */
export function normalizeSpecialty(tag: string): string {
  return tag.trim().replace(/\s+/g, ' ').toLowerCase();
}
