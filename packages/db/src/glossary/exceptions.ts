/**
 * Recorded segment exceptions and the proposals they make (smart-glossary-spec.md
 * §6; backlog #110). A translator who used an acceptable alternative in one
 * segment can record that (`segment_exception`); it is evidence and never moves
 * the preference (`preferredVariant` skips it). When the same alternative has
 * been recorded for `EXCEPTION_PROPOSAL_MIN` distinct segments since the
 * preference last changed, `listExceptionProposals` names it, and a person
 * accepting it writes the ruling (`override`) that moves the preference.
 *
 * Nothing is stored about a proposal: it is a count over the append-only log,
 * so it can never disagree with the decisions that justify it.
 */

import { EXCEPTION_PROPOSAL_MIN, primarySubtag, termKey } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { ensurePrimarySubtagFn } from '../lang-match.js';
import {
  getTerm,
  listVariants,
  preferredVariant,
  recordDecision,
  TermError,
} from './terms.js';

export interface RecordExceptionOptions {
  readonly termId: number;
  /** The project's target language; matched region-insensitively, stored as the variant spells it. */
  readonly lang: string;
  /** The alternative the translator used: an existing, non-forbidden rendering. */
  readonly chosen: string;
  /** Where it was used: both are what makes distinct segments countable. */
  readonly sourceProject: string;
  /** The segment's `ord` in its file (the column's contract, spec §3.4). */
  readonly sourceSegment: number;
  readonly decidedBy: string;
}

/** The non-forbidden variant of a live term holding `chosen` in `lang`, or a `TermError`. */
function alternativeOf(
  db: Database.Database,
  termId: number,
  lang: string,
  chosen: string,
) {
  const term = getTerm(db, termId);
  if (!term || term.deleted) throw new TermError(`term ${termId} is not live`);
  const plain = termKey(chosen);
  const variant = listVariants(db, termId).find(
    (v) =>
      v.plain === plain && primarySubtag(v.lang) === primarySubtag(lang) && !v.forbidden,
  );
  if (!variant) {
    throw new TermError(
      `"${chosen}" is not an acceptable rendering of term ${termId} in ${lang}: ` +
        'only an existing, non-forbidden one can be recorded',
    );
  }
  return variant;
}

/**
 * Appends a `segment_exception`: the translator used `chosen` here. Refused
 * unless it is an existing acceptable rendering other than the preferred one
 * (an exception to nothing is no exception). Recording the same segment twice
 * is harmless: a proposal counts distinct segments.
 */
export function recordSegmentException(
  db: Database.Database,
  options: RecordExceptionOptions,
): void {
  ensurePrimarySubtagFn(db);
  db.transaction(() => {
    const variant = alternativeOf(db, options.termId, options.lang, options.chosen);
    const preferred = preferredVariant(db, options.termId, options.lang);
    if (preferred?.id === variant.id) {
      throw new TermError(
        'that is already the preferred rendering: it is not an exception',
      );
    }
    recordDecision(db, {
      termId: options.termId,
      lang: variant.lang,
      chosen: variant.text,
      rejected: preferred ? [preferred.text] : [],
      kind: 'segment_exception',
      sourceProject: options.sourceProject,
      sourceSegment: options.sourceSegment,
      decidedBy: options.decidedBy,
    });
  })();
}

export interface ExceptionProposal {
  readonly termId: number;
  readonly lang: string;
  /** The alternative, as text. */
  readonly chosen: string;
  /** The preferred rendering it would replace, as text. */
  readonly preferred: string;
  /** Distinct segments it was recorded for since the preference last changed. */
  readonly segments: number;
}

/**
 * The alternatives recorded often enough to propose, most-recorded first. Only
 * decisions after the latest ruling for that term and language count, so
 * accepting (or any later settling) starts the count again; an alternative
 * that has since become preferred, or been forbidden, is not proposed.
 */
export function listExceptionProposals(
  db: Database.Database,
  options: { readonly min?: number } = {},
): ExceptionProposal[] {
  ensurePrimarySubtagFn(db);
  const min = options.min ?? EXCEPTION_PROPOSAL_MIN;
  const rows = db
    .prepare(
      `SELECT d.term_id AS termId, d.lang AS lang, d.chosen AS chosen,
              COUNT(DISTINCT d.source_project || char(31) || d.source_segment) AS segments
       FROM term_decision d
       JOIN term t ON t.id = d.term_id AND t.deleted = 0
       WHERE d.kind = 'segment_exception'
         AND d.source_project IS NOT NULL AND d.source_segment IS NOT NULL
         AND d.id > COALESCE(
           (SELECT MAX(r.id) FROM term_decision r
            WHERE r.term_id = d.term_id AND primary_subtag(r.lang) = primary_subtag(d.lang)
              AND r.kind <> 'segment_exception'), 0)
       GROUP BY d.term_id, d.lang, d.chosen
       HAVING segments >= ?
       ORDER BY segments DESC, d.term_id, d.lang, d.chosen`,
    )
    .all(min) as Array<{
    termId: number;
    lang: string;
    chosen: string;
    segments: number;
  }>;

  const out: ExceptionProposal[] = [];
  for (const row of rows) {
    const plain = termKey(row.chosen);
    const variant = listVariants(db, row.termId).find(
      (v) => v.plain === plain && v.lang === row.lang && !v.forbidden,
    );
    const preferred = preferredVariant(db, row.termId, row.lang);
    if (!variant || !preferred || preferred.id === variant.id) continue;
    out.push({
      termId: row.termId,
      lang: row.lang,
      chosen: variant.text,
      preferred: preferred.text,
      segments: row.segments,
    });
  }
  return out;
}

export interface AcceptProposalOptions {
  readonly termId: number;
  readonly lang: string;
  readonly chosen: string;
  readonly decidedBy: string;
}

/**
 * Accepts a proposal: appends the `override` ruling that makes `chosen` the
 * preferred rendering. Refused unless the proposal stands now, so a stale tab
 * cannot flip an entry nothing proposes to flip.
 */
export function acceptExceptionProposal(
  db: Database.Database,
  options: AcceptProposalOptions,
): void {
  db.transaction(() => {
    const plain = termKey(options.chosen);
    const proposal = listExceptionProposals(db).find(
      (p) =>
        p.termId === options.termId &&
        p.lang === options.lang &&
        termKey(p.chosen) === plain,
    );
    if (!proposal) {
      throw new TermError(
        `nothing proposes "${options.chosen}" for term ${options.termId} any more`,
      );
    }
    recordDecision(db, {
      termId: options.termId,
      lang: options.lang,
      chosen: proposal.chosen,
      rejected: [proposal.preferred],
      kind: 'override',
      decidedBy: options.decidedBy,
    });
  })();
}
