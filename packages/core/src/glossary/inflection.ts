/**
 * The endings a glossary match tolerates on a term's last word
 * (smart-glossary-spec.md §6.1, backlog #43c). Data, not logic, in the
 * way `core/qa/locale.ts` keeps its tables: a closed list per primary
 * subtag, lower-case, each a plain suffix. A language not listed matches
 * the exact word only — a false _mismatch_ for an inflected form, never a
 * false pass.
 */

import { primarySubtag } from '../model/lang.js';

const ENDINGS: Readonly<Record<string, readonly string[]>> = {
  de: ['e', 'en', 'er', 'es', 'em', 'n', 's'],
  es: ['s', 'es'],
  fr: ['s', 'x', 'e', 'es'],
  en: ['s', 'es'],
};

const NONE: readonly string[] = [];

/** The endings tolerated after the last word of a term in `lang` (BCP-47). */
export function inflectionEndings(lang: string): readonly string[] {
  return ENDINGS[primarySubtag(lang)] ?? NONE;
}
