/**
 * Language tags (BCP-47), as far as the base layer needs them.
 *
 * In `model/` since backlog #34: the word count's "does this language
 * space its words" (`words.ts`) needs the primary subtag, and the SPA
 * reaches `model/` at runtime, never `segment/`.
 */

/**
 * The primary subtag of a BCP-47 language tag, lowercased — `es-ES` and
 * `es-419` both give `es`. The one place this split happens; segmentation
 * rule lookup (`segment/rules.ts`), TM pair retrieval (`@cat-tool/db`,
 * tm-format-spec.md §12.2) and the word count all key off it, and all
 * want the same answer for the same tag.
 */
export function primarySubtag(lang: string): string {
  return lang.toLowerCase().split(/[-_]/)[0]!;
}
