/** `qa_issue` repository (v1-spec.md §4.1; backlog #16, #22, #23). */

import {
  QA_RULES,
  plainText,
  type AuditActor,
  runQaChecks,
  type QaIssue,
  type QaRule,
  type QaSiblingContext,
  type QaSeverity,
  type Segment,
  type Token,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { glossaryMismatchFinder } from './glossary-qa.js';
import { getProject } from './project.js';
import { listEnabledRules } from './qa-settings.js';
import { getSegment, SegmentRepoError } from './segments.js';
import { isUntranslatedAllowed } from './qa-untranslated-allowlist.js';

interface QaIssueRow {
  id: number;
  segment_id: number;
  rule: string;
  severity: string;
  message: string;
  dismissed: number;
  run_at: string;
}

const fromRow = (row: QaIssueRow): QaIssue => ({
  id: row.id,
  segmentId: row.segment_id,
  rule: row.rule as QaRule,
  severity: row.severity as QaSeverity,
  message: row.message,
  dismissed: Boolean(row.dismissed),
  runAt: row.run_at,
});

export interface AddQaIssueOptions {
  readonly segmentId: number;
  readonly rule: QaRule;
  readonly severity: QaSeverity;
  readonly message: string;
}

export function addQaIssue(db: Database.Database, options: AddQaIssueOptions): QaIssue {
  const runAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO qa_issue (segment_id, rule, severity, message, run_at)
       VALUES (@segment_id, @rule, @severity, @message, @run_at)`,
    )
    .run({
      segment_id: options.segmentId,
      rule: options.rule,
      severity: options.severity,
      message: options.message,
      run_at: runAt,
    });
  return {
    id: info.lastInsertRowid as number,
    segmentId: options.segmentId,
    rule: options.rule,
    severity: options.severity,
    message: options.message,
    dismissed: false,
    runAt,
  };
}

/** A segment's issues, or every issue in the project when `segmentId` is omitted. */
export function listQaIssues(db: Database.Database, segmentId?: number): QaIssue[] {
  const rows = (
    segmentId === undefined
      ? db.prepare('SELECT * FROM qa_issue ORDER BY segment_id, id').all()
      : db
          .prepare('SELECT * FROM qa_issue WHERE segment_id = ? ORDER BY id')
          .all(segmentId)
  ) as QaIssueRow[];
  return rows.map(fromRow);
}

/**
 * Every issue on one file's segments, dismissed ones included, in
 * document order — the grid's QA gutter and the QA panel (backlog #28,
 * #33). Dismissed issues are the caller's to hide: the gutter does, the
 * panel lists them.
 */
export function listFileQaIssues(db: Database.Database, fileId: number): QaIssue[] {
  const rows = db
    .prepare(
      `SELECT q.* FROM qa_issue q
         JOIN segment s ON s.id = q.segment_id
        WHERE s.file_id = ?
        ORDER BY s.ord, q.id`,
    )
    .all(fileId) as QaIssueRow[];
  return rows.map(fromRow);
}

export class QaIssueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QaIssueError';
  }
}

/**
 * Which finding: a segment and a rule. A rule fires at most once per
 * segment (backlog #22), so the pair names one issue — and, unlike the
 * issue's row id, it still names it after a rerun replaces the row
 * (`replaceQaIssues`), which is also what a dismissal is kept against.
 */
export interface QaIssueKey {
  readonly segmentId: number;
  readonly rule: QaRule;
}

/** Whether `rule` is one of `QA_RULES` — for a key that arrived as text. */
export const isQaRule = (rule: string): rule is QaRule =>
  (QA_RULES as readonly string[]).includes(rule);

/**
 * Sets a live finding aside (spec §6.4), with its actor in the project's
 * log (`qa.dismissed`, audit-spec.md §2.4), in one transaction. It stays
 * dismissed through every rerun that finds the rule again; it is listed
 * still, but no longer blocks (`isBlocking`) or marks the gutter. An
 * issue already dismissed is returned as it is, and nothing is written.
 */
export function dismissQaIssue(
  db: Database.Database,
  key: QaIssueKey,
  options: { readonly actor: AuditActor },
): QaIssue {
  return setDismissed(db, key, true, options.actor);
}

/** Undoes {@link dismissQaIssue}: the finding counts again (`qa.reinstated`). */
export function reinstateQaIssue(
  db: Database.Database,
  key: QaIssueKey,
  options: { readonly actor: AuditActor },
): QaIssue {
  return setDismissed(db, key, false, options.actor);
}

function setDismissed(
  db: Database.Database,
  key: QaIssueKey,
  dismissed: boolean,
  actor: AuditActor,
): QaIssue {
  return db.transaction((): QaIssue => {
    const row = db
      .prepare('SELECT * FROM qa_issue WHERE segment_id = ? AND rule = ?')
      .get(key.segmentId, key.rule) as QaIssueRow | undefined;
    if (!row) {
      throw new QaIssueError(`segment #${key.segmentId} has no ${key.rule} finding`);
    }
    const issue = fromRow(row);
    if (issue.dismissed === dismissed) return issue;
    db.prepare('UPDATE qa_issue SET dismissed = ? WHERE id = ?').run(
      dismissed ? 1 : 0,
      issue.id,
    );
    appendAuditEvent(db, {
      actor,
      action: dismissed ? 'qa.dismissed' : 'qa.reinstated',
      subjectType: 'segment',
      subjectId: String(key.segmentId),
      detail: { rule: key.rule },
    });
    return { ...issue, dismissed };
  })();
}

/**
 * Replaces every issue for a segment with a fresh run's findings, in one
 * transaction. QA is re-run wholesale per segment (`v1-spec.md` §6.4),
 * not diffed against the previous run, so stale issues never linger
 * once whatever caused them is fixed.
 *
 * A dismissal survives the rerun when the same rule fires again, keyed by
 * `rule` alone, not by message: two runs of `tag.missing` are the same
 * decided-about problem even if which ids are missing has since changed,
 * and a dismissal a translator made deliberately (spec §6.4: "issues are
 * dismissible... persisted against the segment") must not evaporate on
 * the very next confirm that re-triggers the same rule. A rule that stops
 * firing loses its dismissal along with the issue itself — there is
 * nothing left to have decided about, which is the existing "stale
 * issues never linger" behaviour, unchanged.
 */
export function replaceQaIssues(
  db: Database.Database,
  segmentId: number,
  findings: readonly Omit<AddQaIssueOptions, 'segmentId'>[],
): QaIssue[] {
  return db.transaction((): QaIssue[] => {
    const previouslyDismissed = new Set(
      listQaIssues(db, segmentId)
        .filter((issue) => issue.dismissed)
        .map((issue) => issue.rule),
    );
    db.prepare('DELETE FROM qa_issue WHERE segment_id = ?').run(segmentId);
    return findings.map((f) => {
      const issue = addQaIssue(db, { ...f, segmentId });
      if (!previouslyDismissed.has(f.rule)) return issue;
      // The decision was logged when it was made; carrying it is not a new one.
      db.prepare('UPDATE qa_issue SET dismissed = 1 WHERE id = ?').run(issue.id);
      return { ...issue, dismissed: true };
    });
  })();
}

interface TranslatedRow {
  id: number;
  source_hash: string;
  source_tokens: string;
  target_tokens: string;
}

/**
 * Every translated segment of the project, keyed both ways
 * `consistency.*` looks (backlog #23): by `source_hash`, and by target
 * plain text (there is no target-text index, so equality is checked in
 * JS after decoding). Read once per QA pass, however many segments it
 * checks: a pass that read the project once *per segment* cost seconds
 * for one save of a segment with a few hundred repetitions (backlog #29).
 * A source is decoded only when a match needs it.
 */
interface TranslatedIndex {
  readonly bySource: ReadonlyMap<string, readonly { id: number; target: string }[]>;
  readonly byTarget: ReadonlyMap<string, readonly TranslatedRow[]>;
}

function readTranslated(db: Database.Database): TranslatedIndex {
  const rows = db
    .prepare(
      `SELECT id, source_hash, source_tokens, target_tokens FROM segment
       WHERE target_tokens IS NOT NULL`,
    )
    .all() as TranslatedRow[];
  const bySource = new Map<string, { id: number; target: string }[]>();
  const byTarget = new Map<string, TranslatedRow[]>();
  for (const row of rows) {
    const target = plainText(JSON.parse(row.target_tokens) as Token[]);
    const sameSource = bySource.get(row.source_hash);
    if (sameSource) sameSource.push({ id: row.id, target });
    else bySource.set(row.source_hash, [{ id: row.id, target }]);
    const sameTarget = byTarget.get(target);
    if (sameTarget) sameTarget.push(row);
    else byTarget.set(target, [row]);
  }
  return { bySource, byTarget };
}

/**
 * One segment's sibling data for `consistency.*` — see the design
 * decision in `planning/v1-backlog.md`'s `#23` entry — out of the
 * project's translated segments.
 */
function siblingContext(index: TranslatedIndex, segment: Segment): QaSiblingContext {
  const sameSourceOtherTargets = (index.bySource.get(segment.sourceHash) ?? [])
    .filter((row) => row.id !== segment.id)
    .map((row) => row.target);
  if (segment.targetTokens === null) {
    return { sameSourceOtherTargets, sameTargetOtherSources: [] };
  }
  const sameTargetOtherSources = (
    index.byTarget.get(plainText(segment.targetTokens)) ?? []
  )
    .filter((row) => row.id !== segment.id && row.source_hash !== segment.sourceHash)
    .map((row) => plainText(JSON.parse(row.source_tokens) as Token[]));
  return { sameSourceOtherTargets, sameTargetOtherSources };
}

/**
 * Runs every enabled, implemented rule (`@cat-tool/core`'s `QA_CHECKS`,
 * backlog #22/#23) against one segment and persists the result via
 * {@link replaceQaIssues}, so a stale finding disappears and a dismissal
 * of a still-firing rule survives.
 *
 * Rules run "per segment on confirm and across the project on demand"
 * (`v1-spec.md` §6.4); a project-wide sweep is {@link runQaRulesFor}
 * over every segment, which reads the project once rather than once per
 * segment.
 */
export function runQaRules(db: Database.Database, segmentId: number): readonly QaIssue[] {
  return runQaRulesFor(db, [segmentId]);
}

/** {@link runQaRules} for several segments, in one transaction, the project read once. */
export function runQaRulesFor(
  db: Database.Database,
  segmentIds: readonly number[],
): QaIssue[] {
  return db.transaction(() => runChecks(db, segmentIds, readTranslated(db)))();
}

function runChecks(
  db: Database.Database,
  segmentIds: readonly number[],
  index: TranslatedIndex,
): QaIssue[] {
  // The locale-aware rules (backlog #24) read the project's language
  // pair; a database with no identity row yet leaves them undefined, and
  // those rules then report nothing rather than guess a locale.
  const project = getProject(db);
  const rules = listEnabledRules(db);
  // Read once per pass, and only if the rule is on.
  const glossary = rules.has('term.glossary_mismatch')
    ? glossaryMismatchFinder(db, project)
    : undefined;
  return segmentIds.flatMap((segmentId) => {
    const segment = getSegment(db, segmentId);
    if (!segment) {
      throw new SegmentRepoError(`no segment with id ${segmentId}`);
    }
    const findings = runQaChecks(
      {
        source: segment.sourceTokens,
        target: segment.targetTokens,
        status: segment.status,
        untranslatedAllowed: isUntranslatedAllowed(db, segment.sourceHash),
        siblings: siblingContext(index, segment),
        srcLang: project?.srcLang,
        tgtLang: project?.tgtLang,
        formats: segment.formatTable,
        glossary,
      },
      rules,
    );
    return replaceQaIssues(db, segmentId, findings);
  });
}

/**
 * QA after one segment's target changed from `before` (backlog #29): the
 * segment itself, and every segment whose `consistency.*` findings the
 * change can move — those sharing its source (`target_differs`), and
 * those whose target reads as its old or its new one
 * (`source_differs`). The ids come back with the findings, the edited
 * segment's first, so a caller holding issues can replace exactly those.
 */
export function rerunQaAfterEdit(
  db: Database.Database,
  segmentId: number,
  before: readonly Token[] | null,
): { rerun: number[]; issues: QaIssue[] } {
  return db.transaction(() => {
    const segment = getSegment(db, segmentId);
    if (!segment) {
      throw new SegmentRepoError(`no segment with id ${segmentId}`);
    }
    const index = readTranslated(db);
    const neighbours = new Set<number>();
    for (const row of index.bySource.get(segment.sourceHash) ?? [])
      neighbours.add(row.id);
    for (const tokens of [before, segment.targetTokens]) {
      if (tokens === null) continue;
      for (const row of index.byTarget.get(plainText(tokens)) ?? [])
        neighbours.add(row.id);
    }
    neighbours.delete(segmentId);
    const rerun = [segmentId, ...[...neighbours].sort((a, b) => a - b)];
    return { rerun, issues: runChecks(db, rerun, index) };
  })();
}

/**
 * QA after segments were split or merged (backlog #30a): the segments
 * now standing, and every segment whose `consistency.*` findings the
 * change can move — those sharing a source they have now or had before
 * (`target_differs`), and those whose target reads as one they have now
 * or had before (`source_differs`). As {@link rerunQaAfterEdit}, for an
 * operation that changes sources and touches several rows at once.
 */
export function rerunQaAfterRestructure(
  db: Database.Database,
  segmentIds: readonly number[],
  before: {
    readonly sourceHashes: readonly string[];
    readonly targets: readonly (readonly Token[] | null)[];
  },
): { rerun: number[]; issues: QaIssue[] } {
  return db.transaction(() => {
    const index = readTranslated(db);
    const neighbours = new Set<number>();
    const hashes = new Set(before.sourceHashes);
    const targets: (readonly Token[] | null)[] = [...before.targets];
    for (const id of segmentIds) {
      const segment = getSegment(db, id);
      if (!segment) throw new SegmentRepoError(`no segment with id ${id}`);
      hashes.add(segment.sourceHash);
      targets.push(segment.targetTokens);
    }
    for (const hash of hashes) {
      for (const row of index.bySource.get(hash) ?? []) neighbours.add(row.id);
    }
    for (const tokens of targets) {
      if (tokens === null) continue;
      for (const row of index.byTarget.get(plainText(tokens)) ?? [])
        neighbours.add(row.id);
    }
    for (const id of segmentIds) neighbours.delete(id);
    const rerun = [...segmentIds, ...[...neighbours].sort((a, b) => a - b)];
    return { rerun, issues: runChecks(db, rerun, index) };
  })();
}
