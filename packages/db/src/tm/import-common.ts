import { QUALITY, type Quality } from './schema.js';

/**
 * Facts shared by every import path into a `.ctm` file.
 *
 * Both importers (`import-tmx.ts`, `import-sdltm.ts`) need this, and a
 * fact with two definitions is a fact that can drift — the mistake
 * `primarySubtag` and `NORMALIZER_VERSION` each fixed once already
 * (CLAUDE.md). This module exists so there is one of it, not two.
 *
 * `refreshLangs` was briefly declared here for the same reason, then
 * turned out to have been given a better home by backlog #20 while this
 * was in flight — `write.ts`'s takes the `(db, options: { schema? })`
 * shape an `ATTACH`ed `.ctm` needs. Both importers call that one; this
 * module deliberately does not keep a second copy.
 */

/**
 * The quality (`tm-format-spec.md` §6) an imported variant lands at.
 *
 * Named here rather than inlined at two call sites because it is a
 * *decision*, and the decision is worth arguing once: neither TMX nor
 * `.sdltm` carries a quality signal this reader can trust — Trados's own
 * confirmation level is bit-packed into `flags` with semantics we have
 * not decoded (§8a) — but a unit that made it into somebody's production
 * memory was confirmed by somebody. `QUALITY.reviewed` would assert a
 * second pair of eyes that may never have existed; `QUALITY.draft` would
 * rank a real memory below this project's own unconfirmed work, since
 * retrieval prefers the highest quality on a tie.
 *
 * The *value* is `schema.ts`'s, not a second 2 spelled out here —
 * `writeBack` reads the same row for a segment a translator confirms.
 * Two different questions, one table.
 */
export const DEFAULT_IMPORTED_QUALITY: Quality = QUALITY.confirmed;
