/**
 * Writes a glossary session's decisions into a `.ctg` (smart-glossary-spec.md
 * §5; backlog #41). `core`'s `GlossarySession` decides and holds every
 * choice in memory until the session ends; this is the one write — every
 * decided or proposed flag becomes a `term_decision` row plus a
 * `term_variant` upsert, in a single transaction, so a session is never
 * half-written (the `insertFile` rule).
 *
 * The session closes only once the transaction has committed
 * (`GlossarySession.commit`): a write that throws rolls all of it back and
 * leaves the session open with every decision in it.
 */

import {
  formatActor,
  primarySubtag,
  type GlossaryImportRow,
  termKey,
  type AuditActor,
  type GlossarySession,
  type SessionEntry,
  type SessionLangs,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { ensurePrimarySubtagFn, matchingLangs } from '../lang-match.js';
import {
  addVariant,
  getTerm,
  insertTerm,
  listVariants,
  recordDecision,
  TermError,
  updateVariant,
} from './terms.js';

export interface CommitGlossaryOptions {
  /**
   * Who confirmed the session — required, never defaulted. Its label is
   * what `decided_by` holds, as `.ctm`'s `updated_by` does: a `.ctg` is
   * portable, and `account:3` means nothing outside this installation
   * (audit-spec.md §2.1).
   */
  readonly actor: AuditActor;
  /** The project the decisions were made in (`term_decision.source_project`). */
  readonly sourceProject?: string;
}

/** A live term with this source rendering in the source language, if any. */
function findTermBySource(
  db: Database.Database,
  srcLang: string,
  srcText: string,
): number | null {
  ensurePrimarySubtagFn(db);
  // `matchingLangs`, not `primary_subtag(lang) = …` on the column: the
  // second turns an indexed lookup into a scan (CLAUDE.md, gotchas).
  const row = db
    .prepare(
      `SELECT v.term_id FROM term_variant v
       JOIN term t ON t.id = v.term_id AND t.deleted = 0
       WHERE v.lang IN ${matchingLangs('term_variant', '@srcLang')} AND v.plain = @plain
       ORDER BY v.term_id LIMIT 1`,
    )
    .get({ srcLang, plain: termKey(srcText) }) as { term_id: number } | undefined;
  return row ? row.term_id : null;
}

/** The term a flag is about: its entry, a live one with that source rendering, or a new one. */
function termFor(
  db: Database.Database,
  langs: SessionLangs,
  entry: SessionEntry,
  decidedBy: string,
): number {
  const { termId, term } = entry.flag;
  if (termId !== null) {
    const existing = getTerm(db, termId);
    if (!existing || existing.deleted) {
      throw new TermError(`"${entry.flag.key}" names term ${termId}, which is not live`);
    }
    return termId;
  }
  return termForSource(db, langs.srcLang, term, decidedBy).termId;
}

/** The live term with this source form, or a new one holding it. */
function termForSource(
  db: Database.Database,
  srcLang: string,
  source: string,
  decidedBy: string,
): { termId: number; created: boolean } {
  const found = findTermBySource(db, srcLang, source);
  if (found !== null) return { termId: found, created: false };
  const termId = insertTerm(db).id;
  addVariant(db, { termId, lang: srcLang, text: source, updatedBy: decidedBy });
  return { termId, created: true };
}

/** A rendering of a term in the target language, and the decision that settles it. */
interface RenderingWrite {
  readonly termId: number;
  readonly tgtLang: string;
  readonly rendering: string;
  readonly rejected: readonly string[];
  readonly kind: SessionEntry['kind'];
  readonly decidedBy: string;
  readonly sourceProject?: string;
  readonly sourceSegment?: number;
  /** A note on the rendering's variant; omitted leaves an existing note alone, null clears it. */
  readonly note?: string | null;
}

/**
 * The one write of a settled rendering: its variant (added, or cleared of
 * `forbidden` unless the decision is a deprecation) and the `term_decision`
 * row. Shared by a session's commit and by `addTermFromText`, so a term typed
 * in the editor and one decided in the panel are the same kind of row.
 */
function writeRendering(db: Database.Database, write: RenderingWrite): void {
  const plain = termKey(write.rendering);
  const forbid = write.kind === 'deprecation';

  // The rendering's variant, in whatever regional spelling of the target
  // language the term already holds it — never a second one beside it.
  const existing = listVariants(db, write.termId).find(
    (v) => v.plain === plain && primarySubtag(v.lang) === primarySubtag(write.tgtLang),
  );
  let lang = write.tgtLang;
  if (!existing) {
    addVariant(db, {
      termId: write.termId,
      lang,
      text: write.rendering,
      note: write.note ?? undefined,
      forbidden: forbid,
      updatedBy: write.decidedBy,
    });
  } else {
    lang = existing.lang;
    // `rev` moves only for a real change: choosing a rendering the entry
    // already holds is a decision (logged below), not an edit of the entry.
    // Choosing a forbidden one clears it — the translator is the authority
    // (decision 5), and the decision row is where that is recorded.
    const noteChanged = write.note !== undefined && write.note !== existing.note;
    if (existing.forbidden !== forbid || noteChanged) {
      updateVariant(db, existing.id, {
        forbidden: forbid,
        ...(noteChanged ? { note: write.note } : {}),
        updatedBy: write.decidedBy,
      });
    }
  }

  recordDecision(db, {
    termId: write.termId,
    lang,
    chosen: write.rendering,
    rejected: write.rejected,
    kind: write.kind,
    sourceProject: write.sourceProject,
    sourceSegment: write.sourceSegment,
    decidedBy: write.decidedBy,
  });
}

function applyEntry(
  db: Database.Database,
  session: { readonly langs: SessionLangs },
  entry: SessionEntry,
  options: { decidedBy: string; sourceProject?: string },
): void {
  const { langs } = session;
  writeRendering(db, {
    termId: termFor(db, langs, entry, options.decidedBy),
    tgtLang: langs.tgtLang,
    rendering: entry.rendering,
    rejected: entry.rejected,
    kind: entry.kind,
    decidedBy: options.decidedBy,
    sourceProject: options.sourceProject,
    sourceSegment: entry.flag.firstOrd ?? undefined,
  });
}

export interface AddTermOptions {
  readonly srcLang: string;
  readonly tgtLang: string;
  /** The source-language form, as the translator typed or selected it. */
  readonly source: string;
  /** Its rendering in the target language. */
  readonly target: string;
  /** Who added it — required, never defaulted (as {@link CommitGlossaryOptions}). */
  readonly actor: AuditActor;
  readonly sourceProject?: string;
}

export interface AddTermResult {
  readonly termId: number;
  /** False when a live term with that source form already existed and was added to. */
  readonly created: boolean;
}

/**
 * Records one term the translator typed or selected in the editor
 * (backlog #129, issue #151): the term for that source form, found or created,
 * and the rendering as a `custom` decision (decision 3: a translator may
 * always type their own). One transaction, the same write a panel session's
 * commit makes, without a session: the term was not detected, it was known.
 */
export function addTermFromText(
  db: Database.Database,
  options: AddTermOptions,
): AddTermResult {
  const source = options.source.trim();
  const target = options.target.trim();
  if (termKey(source) === '') throw new TermError('a term needs a source form');
  if (termKey(target) === '') throw new TermError('a term needs a rendering');
  const decidedBy = options.actor.label ?? formatActor(options.actor.actor);
  return db.transaction((): AddTermResult => {
    const { termId, created } = termForSource(db, options.srcLang, source, decidedBy);
    writeRendering(db, {
      termId,
      tgtLang: options.tgtLang,
      rendering: target,
      rejected: [],
      kind: 'custom',
      decidedBy,
      sourceProject: options.sourceProject,
    });
    return { termId, created };
  })();
}

/** The note a `keep` row's rendering carries. */
export const KEEP_NOTE = 'kept as in the source language';
/** The note a `review` row's rendering carries (a `.ctg` has no term status). */
export const REVIEW_NOTE = 'under review';

/** Every note an import can write, so a later import knows which ones are its own. */
const IMPORT_NOTES: ReadonlySet<string> = new Set([
  KEEP_NOTE,
  REVIEW_NOTE,
  `${KEEP_NOTE}; ${REVIEW_NOTE}`,
]);

export interface ImportGlossaryOptions {
  /** The language of every row's `term`. */
  readonly srcLang: string;
  /** Who imported — required, never defaulted (as {@link CommitGlossaryOptions}). */
  readonly actor: AuditActor;
  readonly sourceProject?: string;
}

export interface ImportGlossaryResult {
  /** Terms the file created. */
  readonly termsCreated: number;
  /** Terms the file added a rendering to that were already in the glossary. */
  readonly termsExisting: number;
  /** Renderings written (one `custom` decision each). */
  readonly renderings: number;
  /** Renderings written as `forbidden` (one `deprecation` decision each). */
  readonly forbidden: number;
  /** Rows carrying `review`, whose renderings were noted rather than withheld. */
  readonly review: number;
}

/** Thrown by {@link importGlossaryRows} with the row's own line; the file is left as it was. */
export class GlossaryImportError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'GlossaryImportError';
  }
}

/**
 * Imports rows `parseGlossaryCsv` accepted (Epic 16 slice S3, issue #356):
 * all of them or none. Each row finds or creates its term by source form, then
 * writes its rendering as a `custom` decision through {@link writeRendering},
 * the same write the editor's add-term and a session's commit make, and each
 * `avoid` entry as a `forbidden` rendering (a `deprecation` decision). A `keep`
 * or `review` row says so in the rendering's note. One transaction, so a row the
 * `.ctg` refuses (a `TermError`) rolls back everything before it and is reported
 * with its line.
 *
 * Importing the same file twice adds a second decision per rendering and moves
 * nothing else: the log records that someone chose it again.
 *
 * @throws {GlossaryImportError} on a row the glossary refuses.
 */
export function importGlossaryRows(
  db: Database.Database,
  rows: readonly GlossaryImportRow[],
  options: ImportGlossaryOptions,
): ImportGlossaryResult {
  const decidedBy = options.actor.label ?? formatActor(options.actor.actor);
  return db.transaction((): ImportGlossaryResult => {
    let termsCreated = 0;
    let termsExisting = 0;
    let renderings = 0;
    let forbidden = 0;
    let review = 0;
    for (const row of rows) {
      try {
        const { termId, created } = termForSource(
          db,
          options.srcLang,
          row.term,
          decidedBy,
        );
        if (created) termsCreated++;
        else termsExisting++;
        const notes = [
          row.keep ? KEEP_NOTE : null,
          row.status === 'review' ? REVIEW_NOTE : null,
        ];
        const wanted = notes.filter((n) => n !== null).join('; ');
        // A row that is plain `official` clears the notes an earlier import
        // wrote, and only those.
        const held = listVariants(db, termId).find(
          (v) =>
            v.plain === termKey(row.rendering) &&
            primarySubtag(v.lang) === primarySubtag(row.lang),
        )?.note;
        const ours = held == null || IMPORT_NOTES.has(held);
        // A note a person typed is theirs: ours is added after it, once, never over it.
        const note =
          wanted === ''
            ? ours && held != null
              ? null
              : undefined
            : ours
              ? wanted
              : held.includes(wanted)
                ? undefined
                : `${held}; ${wanted}`;
        const base = {
          termId,
          tgtLang: row.lang,
          rejected: [] as string[],
          decidedBy,
          sourceProject: options.sourceProject,
        };
        writeRendering(db, {
          ...base,
          rendering: row.rendering,
          kind: 'custom',
          note,
        });
        // The parse refused an `avoid` entry equal to the rendering, so no
        // forbidden write here can flip the variant the line above settled.
        for (const avoided of row.avoid) {
          writeRendering(db, { ...base, rendering: avoided, kind: 'deprecation' });
          forbidden++;
        }
        renderings++;
        if (row.status === 'review') review++;
      } catch (err) {
        if (err instanceof TermError)
          throw new GlossaryImportError(row.line, err.message);
        throw err;
      }
    }
    return { termsCreated, termsExisting, renderings, forbidden, review };
  })();
}

/**
 * Commits the session into `db`: one transaction, one `term_decision` per
 * decided or proposed flag, in flag order. Returns how many were written.
 * A skipped or undecided flag writes nothing and is remembered nowhere.
 */
export function commitGlossarySession(
  db: Database.Database,
  session: GlossarySession,
  options: CommitGlossaryOptions,
): number {
  const decidedBy = options.actor.label ?? formatActor(options.actor.actor);
  return session.commit((entries) =>
    db.transaction(() => {
      for (const entry of entries) {
        applyEntry(db, session, entry, {
          decidedBy,
          sourceProject: options.sourceProject,
        });
      }
    })(),
  );
}
