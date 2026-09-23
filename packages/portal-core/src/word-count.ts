/**
 * Word count estimation (portal-v0-spec.md §4).
 *
 * Deliberately naive and deliberately not `@cat-tool/core`'s segmenter —
 * that pipeline exists for TM/QA correctness, not a quick client-facing
 * estimate, and wiring the portal to it now would couple a business
 * object to engine internals (see §1). Exact for `.txt`; every other
 * supported type is left `null` ("estimate pending") for the admin to
 * fill in by hand.
 */

export const AUTO_ESTIMABLE_CONTENT_TYPES = ['text/plain'] as const;

/** Whitespace word count. Exact for plain text, not used for anything else. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
}

/**
 * Best-effort word count for one uploaded file. Returns `null` when the
 * content type isn't one v0 can estimate automatically — the admin sets
 * the count manually in that case, per §4.
 */
export function estimateWordCount(
  contentType: string,
  text: string | null,
): number | null {
  if (!(AUTO_ESTIMABLE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return null;
  }
  return text === null ? null : countWords(text);
}
