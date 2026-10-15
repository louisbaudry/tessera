/**
 * The glossary terms a draft's prompt carries (`planning/translation-engine-spec.md`
 * §3 step 3; backlog #135).
 *
 * Which entries occur in a source is the mismatch matcher's own question
 * (`smart-glossary-spec.md` §6.1), answered the same way: `termKey`ed text,
 * a whole-word match, an inflection ending tolerated on the last word. So the
 * prompt names exactly the terms `term.glossary_mismatch` would later hold the
 * draft to. Pure, like the rest of `core/draft`: entries arrive as arguments,
 * read by `db` from the project's write-target `.ctg`.
 */

import { inflectionEndings } from '../glossary/inflection.js';
import { termKey } from '../glossary/key.js';
import { wordSpans, type GlossaryTermEntry } from '../glossary/mismatch.js';
import { plainText, type AnyToken } from '../model/token.js';
import type { DraftTerm } from './prompt.js';

/**
 * The entries whose source form occurs in `source`, as prompt terms, in
 * entry order. `source` is the segment's tokens: its text is what is
 * searched, tags and all dropped. An entry with only forbidden renderings
 * comes back with `preferred: null`, since forbidding is a rule on its own.
 */
export function draftTerms(
  entries: readonly GlossaryTermEntry[],
  source: readonly AnyToken[],
  srcLang: string,
): DraftTerm[] {
  const text = termKey(plainText(source));
  if (text === '') return [];
  const endings = inflectionEndings(srcLang);
  const out: DraftTerm[] = [];
  for (const entry of entries) {
    const matched = entry.source.find(
      (form) => wordSpans(text, form.plain, endings).length > 0,
    );
    if (!matched) continue;
    out.push({
      source: matched.text,
      preferred: entry.preferred?.text ?? null,
      forbidden: entry.forbidden.map((f) => f.text),
    });
  }
  return out;
}
