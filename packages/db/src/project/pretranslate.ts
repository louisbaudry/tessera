/**
 * Pre-translate: the exact matcher (v1-spec.md §6.1; backlog #19).
 *
 * Ties together what #16-#18 already built — `tm_ref` priority order
 * (`tm-refs.ts`), the schema-qualified pair query (`tm/retrieve.ts`'s
 * `retrievePair`), and the placement policy (`core/tm/pretranslate.ts`'s
 * `placeMatch`) — into the one batch operation a translator actually
 * runs: for every eligible segment, an exact-hash TM hit in priority
 * order (first hit wins), falling back to internal propagation from an
 * already-confirmed sibling segment sharing the same `source_hash`.
 *
 * Idempotent and never touches a confirmed or locked segment
 * (`core/model/segment.ts`'s `isProtectedFromPretranslate` — the same
 * fact `setSegmentTarget` itself already refuses on for `locked`).
 */

import {
  DEFAULT_FUZZY_THRESHOLD,
  FUZZY_FLOOR,
  FUZZY_MAX_SCORE,
  fuzzyOrigin,
  hasSpacedWords,
  isProtectedFromPretranslate,
  operandOfSource,
  placeMatch,
  toTmTokens,
  type AuditActor,
  type Segment,
  type TmRef,
  type TmToken,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { retrieveFuzzy } from '../tm/fuzzy.js';
import { retrievePair } from '../tm/retrieve.js';
import { getProject } from './project.js';
import { replaceQaIssues } from './qa-issues.js';
import { listAllSegments, setSegmentTarget } from './segments.js';
import { attachTms, listTmRefs, tmAlias } from './tm-refs.js';

export class PretranslateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PretranslateError';
  }
}

export interface PretranslateOptions {
  /**
   * Limit *candidate* segments to one file; omit to pre-translate the
   * whole project. Internal-propagation donors are always drawn from
   * every confirmed segment in the project regardless of this filter —
   * v1-spec.md §6.1 step 4 says "the project", not "the file".
   */
  readonly fileId?: number;
  /**
   * Who ran it — required (audit-spec.md decision 3). The run is one
   * `project.pretranslate` event, and every segment it changes is a
   * `segment.target_set` child of it (spec §2.3).
   */
  readonly actor: AuditActor;
  /**
   * The lowest fuzzy score written into a segment (v1-spec.md §6.1a, 2);
   * defaults to {@link DEFAULT_FUZZY_THRESHOLD}. `null` turns fuzzy off, so
   * a run is exactly the exact-and-propagation pre-translate it was.
   * Below it a match exists but is never placed: a 60% match in the target
   * is noise the translator deletes.
   */
  readonly fuzzyThreshold?: number | null;
}

export interface PretranslateSummary {
  /** Full tag-and-text match from a TM — `origin: 'tm_exact'`. */
  readonly exact: number;
  /** Same source text, but the match's tags didn't correspond to this segment's — text only, `origin: 'tm_exact_tagdiff'`, flagged for review. */
  readonly tagdiff: number;
  /** A fuzzy match at or above the threshold — a draft, `origin: 'tm_fuzzy_<score>'` (v1-spec.md §6.1a). */
  readonly fuzzy: number;
  /** No TM hit; populated from an already-confirmed sibling segment sharing the same source hash — `origin: 'propagated'`. */
  readonly propagated: number;
  /** Eligible but nothing matched — left untouched. */
  readonly unmatched: number;
  /** Confirmed or locked; never touched (v1-spec.md §6.1). */
  readonly skipped: number;
}

const TAGDIFF_MESSAGE = (source: string): string =>
  `Tags from ${source} did not correspond to this segment's source — inserted as ` +
  'plain text; tags need to be reapplied.';

/** One segment's decided placement, written only after the run's parent event. */
interface Placement {
  readonly segment: Segment;
  readonly targetTokens: Segment['targetTokens'];
  readonly tagsMatched: boolean;
  readonly origin: string;
  readonly status: 'translated' | 'draft';
  readonly sourceLabel: string;
}

/**
 * Runs pre-translate over a project's segments, as one transaction: a
 * thrown error (a locked segment slipping through, a corrupt TM row)
 * leaves every segment exactly as it was, never half pre-translated.
 *
 * Every placement is decided before anything is written: the run's
 * `project.pretranslate` event carries the final counts, and it has to
 * be in the log before any child can point at it (audit-spec.md §2.4).
 * Deciding first changes no answer — donors are frozen up front and
 * the TMs are only read.
 */
export function pretranslate(
  db: Database.Database,
  options: PretranslateOptions,
): PretranslateSummary {
  const project = getProject(db);
  if (!project) {
    throw new PretranslateError('project has no identity row — nothing to pre-translate');
  }
  const fuzzyThreshold =
    options.fuzzyThreshold === undefined
      ? DEFAULT_FUZZY_THRESHOLD
      : options.fuzzyThreshold;
  if (
    fuzzyThreshold !== null &&
    (!Number.isInteger(fuzzyThreshold) ||
      fuzzyThreshold < FUZZY_FLOOR ||
      fuzzyThreshold > FUZZY_MAX_SCORE)
  ) {
    throw new PretranslateError(
      `fuzzy threshold must be a whole number from ${FUZZY_FLOOR} to ${FUZZY_MAX_SCORE}, or off`,
    );
  }
  // An unspaced source has no word to score (`hasSpacedWords`).
  const fuzzyOn = fuzzyThreshold !== null && hasSpacedWords(project.srcLang);

  // ATTACHing must happen before the transaction below starts — SQLite
  // refuses ATTACH/DETACH once one is open.
  const attached = attachTms(db, listTmRefs(db)); // already priority order

  const run = db.transaction((): PretranslateSummary => {
    const allSegments = listAllSegments(db);
    const candidates =
      options.fileId === undefined
        ? allSegments
        : allSegments.filter((s) => s.fileId === options.fileId);

    // Propagation donors: the first confirmed segment encountered
    // (document order) per source hash. Frozen here, before any writes —
    // a segment this same run pre-translates via TM match is never itself
    // eligible as a donor within the same run; only a hash a translator
    // had *already* confirmed counts (v1-spec.md §6.1's "when one is
    // confirmed").
    const donorByHash = new Map<string, Segment>();
    for (const segment of allSegments) {
      if (
        segment.status === 'confirmed' &&
        segment.targetTokens &&
        !donorByHash.has(segment.sourceHash)
      ) {
        donorByHash.set(segment.sourceHash, segment);
      }
    }

    // Segments sharing a source hash ask the same TM question twice —
    // cache the answer per hash for this run rather than re-querying
    // every attached TM again.
    const tmMatchCache = new Map<string, readonly TmToken[] | null>();
    const findTmMatch = (srcHash: string): readonly TmToken[] | null => {
      const cached = tmMatchCache.get(srcHash);
      if (cached !== undefined) return cached;
      const found = findExactTmMatch(
        db,
        attached,
        project.srcLang,
        project.tgtLang,
        srcHash,
      );
      tmMatchCache.set(srcHash, found);
      return found;
    };

    // The score depends on the segment's visible tags as well as its text,
    // so the cache is keyed by both.
    const fuzzyCache = new Map<string, FuzzyHit | null>();
    const findFuzzy = (segment: Segment): FuzzyHit | null => {
      const operand = operandOfSource(segment.sourceTokens, segment.formatTable);
      const key = `${operand.plain}\u0000${operand.tagSlots.join(',')}`;
      const cached = fuzzyCache.get(key);
      if (cached !== undefined) return cached;
      const found = findBestFuzzyMatch(
        db,
        attached,
        project.srcLang,
        project.tgtLang,
        operand,
        fuzzyThreshold!,
      );
      fuzzyCache.set(key, found);
      return found;
    };

    let exact = 0;
    let tagdiff = 0;
    let fuzzy = 0;
    let propagated = 0;
    let unmatched = 0;
    let skipped = 0;
    const placements: Placement[] = [];

    for (const segment of candidates) {
      if (isProtectedFromPretranslate(segment)) {
        skipped++;
        continue;
      }

      const tmMatch = findTmMatch(segment.sourceHash);
      if (tmMatch) {
        const placed = placeMatch(tmMatch, segment.sourceTokens, segment.formatTable);
        placements.push({
          segment,
          targetTokens: placed.targetTokens,
          tagsMatched: placed.tagsMatched,
          origin: placed.tagsMatched ? 'tm_exact' : 'tm_exact_tagdiff',
          status: placed.tagsMatched ? 'translated' : 'draft',
          sourceLabel: 'a TM match',
        });
        if (placed.tagsMatched) exact++;
        else tagdiff++;
        continue;
      }

      const donor = donorByHash.get(segment.sourceHash);
      if (donor) {
        const donorTmTokens = toTmTokens(donor.targetTokens!, donor.formatTable);
        const placed = placeMatch(
          donorTmTokens,
          segment.sourceTokens,
          segment.formatTable,
        );
        placements.push({
          segment,
          targetTokens: placed.targetTokens,
          tagsMatched: placed.tagsMatched,
          origin: 'propagated',
          status: 'draft',
          sourceLabel: 'an internal propagation match',
        });
        propagated++;
        continue;
      }

      const fuzzyHit = fuzzyOn ? findFuzzy(segment) : null;
      if (fuzzyHit) {
        const placed = placeMatch(
          fuzzyHit.tokens,
          segment.sourceTokens,
          segment.formatTable,
        );
        placements.push({
          segment,
          targetTokens: placed.targetTokens,
          tagsMatched: placed.tagsMatched,
          origin: fuzzyOrigin(fuzzyHit.score),
          status: 'draft',
          sourceLabel: `a ${fuzzyHit.score}% fuzzy TM match`,
        });
        fuzzy++;
        continue;
      }

      unmatched++;
    }

    const summary = { exact, tagdiff, fuzzy, propagated, unmatched, skipped };
    const batch = appendAuditEvent(db, {
      actor: options.actor,
      action: 'project.pretranslate',
      subjectType: 'project',
      subjectId: null,
      detail: { tm_refs: attached.map((r) => r.path), counts: summary },
    });
    for (const placement of placements) {
      writePlacement(db, placement, options.actor, batch.id);
    }
    return summary;
  });
  return run();
}

/** Queries each attached TM in priority order; the first non-empty hit wins (v1-spec.md §6.1 step 2). */
function findExactTmMatch(
  db: Database.Database,
  refs: readonly TmRef[],
  srcLang: string,
  tgtLang: string,
  srcHash: string,
): readonly TmToken[] | null {
  for (const ref of refs) {
    const matches = retrievePair(
      db,
      { srcLang, srcHash, tgtLang },
      { schema: tmAlias(ref.id) },
    );
    if (matches.length > 0) return matches[0]!.tokens;
  }
  return null;
}

interface FuzzyHit {
  readonly score: number;
  readonly tokens: readonly TmToken[];
}

/**
 * The best fuzzy match across the attached TMs: the highest score wins, and
 * on a tie the memory earlier in priority order (v1-spec.md §6.1a, 5).
 * A lower-priority memory's better match still beats a higher one's worse
 * match: priority breaks ties, it does not outrank a closer match.
 */
function findBestFuzzyMatch(
  db: Database.Database,
  refs: readonly TmRef[],
  srcLang: string,
  tgtLang: string,
  source: ReturnType<typeof operandOfSource>,
  minScore: number,
): FuzzyHit | null {
  let best: FuzzyHit | null = null;
  for (const ref of refs) {
    const [top] = retrieveFuzzy(
      db,
      { srcLang, tgtLang, source, minScore, limit: 1 },
      { schema: tmAlias(ref.id) },
    );
    if (top && (best === null || top.score > best.score)) {
      best = { score: top.score, tokens: top.tokens };
    }
  }
  return best;
}

/**
 * Writes the placed target and, wholesale, this segment's pre-translate
 * QA finding — `replaceQaIssues` clears a stale one on a since-improved
 * rerun as readily as it adds a fresh one, which is exactly the
 * idempotency pre-translate needs (`db/project/qa-issues.ts`: QA is
 * re-run wholesale per segment, never diffed).
 */
function writePlacement(
  db: Database.Database,
  placement: Placement,
  actor: AuditActor,
  batchId: number,
): void {
  const { segment, targetTokens, tagsMatched, origin, status, sourceLabel } = placement;
  setSegmentTarget(db, segment.id, { targetTokens, status, origin, actor, batchId });
  replaceQaIssues(
    db,
    segment.id,
    tagsMatched
      ? []
      : [
          {
            rule: 'tag.missing',
            severity: 'warning',
            message: TAGDIFF_MESSAGE(sourceLabel),
          },
        ],
  );
}
