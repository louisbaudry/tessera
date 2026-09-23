/**
 * Project and TM-reference model. See planning/v1-spec.md §4.1.
 *
 * `ProjectFile` is not here: it carries a `PartSkeleton[]`
 * (`docx/skeleton.ts`), and putting it here would have `model/` import
 * from `docx/` — the wrong direction. It lives in `docx/document.ts`,
 * next to `DocxDocument`, which is what it really is: a persisted one.
 */

export interface Project {
  readonly name: string;
  /** BCP-47, e.g. `en-GB`. */
  readonly srcLang: string;
  readonly tgtLang: string;
  readonly createdAt: string;
  readonly schemaVersion: number;
}

/**
 * A `.ctm` file attached to a project. `priority` breaks ties between
 * exact hits from different TMs — lowest wins. At most one row may have
 * `isWriteTarget: true`, enforced by the schema's partial unique index.
 */
export interface TmRef {
  readonly id: number;
  /** Path to the `.ctm` file. */
  readonly path: string;
  readonly priority: number;
  readonly isWriteTarget: boolean;
  readonly enabled: boolean;
}

/**
 * A `.ctg` glossary attached to a project (smart-glossary-spec.md §2.1).
 * Deliberately the same shape as {@link TmRef}: a client glossary
 * attached over a base glossary is `priority` resolution, the mechanism
 * TM references already have, not a new concept. The write target is
 * the glossary a session's decisions are committed to — the client's,
 * in practice.
 */
export interface GlossaryRef {
  readonly id: number;
  /** Path to the `.ctg` file. */
  readonly path: string;
  readonly priority: number;
  readonly isWriteTarget: boolean;
  readonly enabled: boolean;
}
