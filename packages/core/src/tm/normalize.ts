/**
 * Normalisation and hashing (tm-format-spec.md §4; backlog #17).
 *
 * `plain`/`hash` are what exact matching actually keys off — two
 * segments differing only by an invisible non-breaking space, or a
 * curly vs. straight quote, must produce the same hash, or "exact
 * matching" misses the single most common real-world case it exists
 * for. Case and diacritics are deliberately **not** touched: `ácido`
 * and `acido` are different units, full stop.
 *
 * **This rule set is frozen for `NORMALIZER_VERSION = 1`.** Changing a
 * rule here without bumping the version silently invalidates every
 * hash in every existing memory — see `openAndMigrate`'s
 * `normalizer_version` handling once a reader needs to detect drift.
 * Nothing here does that rehashing; this module only computes the
 * current version's answer.
 */

import { createHash } from 'node:crypto';

import { plainText, type AnyToken } from '../model/token.js';

/** The frozen rule set version this module implements. */
export const NORMALIZER_VERSION = 1;

/**
 * Typographic variants folded to one canonical form, spelled out by
 * codepoint (tm-format-spec.md §4 step 4) rather than left as glyphs in
 * source — a glyph in a source file can be silently re-mangled by an
 * editor or a copy-paste, which is exactly the bug this rule exists to
 * undo and exactly the bug that once slipped into the spec's own prose.
 */
const TYPOGRAPHIC_VARIANTS: ReadonlyArray<readonly [RegExp, string]> = [
  // Single quotes -> U+0027.
  [/[‘’‚‛]/gu, "'"],
  // Double quotes -> U+0022.
  [/[“”„‟«»]/gu, '"'],
  // Dashes -> U+002D.
  [/[–—‒]/gu, '-'],
  // NBSP, NNBSP, thin space -> a plain space. Collapsed further below.
  [/[   ]/gu, ' '],
  // Ellipsis -> three literal dots.
  [/…/gu, '...'],
  // Primes -> the quote marks they visually resemble.
  [/′/gu, "'"],
  [/″/gu, '"'],
  // Soft hyphen -> nothing; it is not a visible character.
  [/­/gu, ''],
];

/**
 * Produces `plain` from raw text: NFC, typographic variants folded,
 * whitespace collapsed to single spaces and trimmed. Case and
 * diacritics untouched.
 *
 * The spec lists "collapse whitespace" before "canonicalise typographic
 * variants", but they run in the opposite order here: NBSP and thin
 * space are *also* whitespace, so collapsing first (with an ASCII-only
 * notion of whitespace) would leave runs like `"   "` only
 * partially collapsed. Folding typographic variants to plain spaces
 * first, then collapsing, is what actually produces one canonical
 * space — the numbered list describes the rule set, not a pipeline.
 */
export function normalizeText(text: string): string {
  let out = text.normalize('NFC');
  for (const [pattern, replacement] of TYPOGRAPHIC_VARIANTS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** SHA-256 of already-normalised text, lowercase hex. */
function sha256Hex(plain: string): string {
  return createHash('sha256').update(plain, 'utf8').digest('hex');
}

/** SHA-256 of normalised text, lowercase hex — the `hash` column. */
export function hashOf(text: string): string {
  return sha256Hex(normalizeText(text));
}

/**
 * `plain` and `hash` together from a token stream — tags dropped (via
 * {@link plainText}, shared with the TM's own reduced token model),
 * then normalised and hashed once. What a `tuv` write actually needs.
 */
export function normalizeTokens(tokens: readonly AnyToken[]): {
  readonly plain: string;
  readonly hash: string;
} {
  const plain = normalizeText(plainText(tokens));
  return { plain, hash: sha256Hex(plain) };
}
