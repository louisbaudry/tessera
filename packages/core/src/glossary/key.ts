/**
 * The one definition of "the same term" (smart-glossary-spec.md §2.3,
 * §3.3). `core/glossary/` imports from `model/` and `tm/` only; nothing
 * below `project/` may import from here.
 */

import { normalizeText } from '../tm/normalize.js';

/**
 * The `term_variant.plain` column: the frozen `normalizer_version = 1`
 * rules (so `logiciel\u00A0libre` and `logiciel libre` are one term),
 * then case-folded — a glossary lookup that treated `Logiciel` and
 * `logiciel` as different terms would miss every sentence-initial
 * occurrence.
 *
 * Case-folding is the one step segment hashing deliberately does *not*
 * take (tm-format-spec.md §4: "case does not" hash equal), which is why
 * this is its own function rather than a flag on `normalizeText`: the
 * two are different facts about different things. `toLowerCase()` is
 * locale-independent on purpose; none of the seven v1 languages has a
 * locale-sensitive case mapping (Turkish dotless-i would).
 */
export function termKey(text: string): string {
  return normalizeText(text).toLowerCase();
}
