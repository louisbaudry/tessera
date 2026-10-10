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
  const found = findTermBySource(db, langs.srcLang, term);
  if (found !== null) return found;
  const created = insertTerm(db);
  addVariant(db, {
    termId: created.id,
    lang: langs.srcLang,
    text: term,
    updatedBy: decidedBy,
  });
  return created.id;
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
      forbidden: forbid,
      updatedBy: write.decidedBy,
    });
  } else {
    lang = existing.lang;
    // `rev` moves only for a real change: choosing a rendering the entry
    // already holds is a decision (logged below), not an edit of the entry.
    // Choosing a forbidden one clears it — the translator is the authority
    // (decision 5), and the decision row is where that is recorded.
    if (existing.forbidden !== forbid) {
      updateVariant(db, existing.id, { forbidden: forbid, updatedBy: write.decidedBy });
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
    let termId = findTermBySource(db, options.srcLang, source);
    const created = termId === null;
    if (termId === null) {
      termId = insertTerm(db).id;
      addVariant(db, {
        termId,
        lang: options.srcLang,
        text: source,
        updatedBy: decidedBy,
      });
    }
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
