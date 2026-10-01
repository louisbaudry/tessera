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

function applyEntry(
  db: Database.Database,
  session: { readonly langs: SessionLangs },
  entry: SessionEntry,
  options: { decidedBy: string; sourceProject?: string },
): void {
  const { langs } = session;
  const termId = termFor(db, langs, entry, options.decidedBy);
  const plain = termKey(entry.rendering);
  const forbid = entry.kind === 'deprecation';

  // The rendering's variant, in whatever regional spelling of the target
  // language the term already holds it — never a second one beside it.
  const existing = listVariants(db, termId).find(
    (v) => v.plain === plain && primarySubtag(v.lang) === primarySubtag(langs.tgtLang),
  );
  let lang = langs.tgtLang;
  if (!existing) {
    addVariant(db, {
      termId,
      lang,
      text: entry.rendering,
      forbidden: forbid,
      updatedBy: options.decidedBy,
    });
  } else {
    lang = existing.lang;
    // `rev` moves only for a real change: choosing a rendering the entry
    // already holds is a decision (logged below), not an edit of the entry.
    // Choosing a forbidden one clears it — the translator is the authority
    // (decision 5), and the decision row is where that is recorded.
    if (existing.forbidden !== forbid) {
      updateVariant(db, existing.id, { forbidden: forbid, updatedBy: options.decidedBy });
    }
  }

  recordDecision(db, {
    termId,
    lang,
    chosen: entry.rendering,
    rejected: entry.rejected,
    kind: entry.kind,
    sourceProject: options.sourceProject,
    sourceSegment: entry.flag.firstOrd ?? undefined,
    decidedBy: options.decidedBy,
  });
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
