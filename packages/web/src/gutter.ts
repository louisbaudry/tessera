/**
 * The grid's gutter: three facts, each from one field (v1-spec.md §7.1).
 *
 * The tables are `Record`s keyed by `core`'s own unions, so a status or
 * severity added there fails this package's typecheck instead of
 * rendering blank.
 */
import type {
  KnownOrigin,
  Origin,
  QaIssue,
  QaSeverity,
  Segment,
  SegmentStatus,
} from '@cat-tool/core';

export interface Badge {
  readonly text: string;
  readonly title: string;
}

export const STATUS_BADGE: Readonly<Record<SegmentStatus, Badge>> = {
  new: { text: '', title: 'New' },
  draft: { text: 'D', title: 'Draft' },
  translated: { text: 'T', title: 'Translated' },
  confirmed: { text: '\u2713', title: 'Confirmed' },
  locked: { text: '\u{1F512}', title: 'Locked' }, // 🔒
};

/** A segment locked by the filter keeps its status but is shown locked. */
export function statusOf(segment: Pick<Segment, 'status' | 'locked'>): SegmentStatus {
  return segment.locked ? 'locked' : segment.status;
}

const ORIGIN_BADGE: Readonly<Record<KnownOrigin, Badge>> = {
  tm_exact: { text: 'TM', title: 'Exact TM match' },
  tm_exact_tagdiff: { text: 'TM\u2260', title: 'Exact TM match, tags differ' },
  propagated: { text: '\u21E3', title: 'Propagated from a repeated segment' },
};

/**
 * Origin is a widened string (v1-spec.md §4.3): a value this table does
 * not know is shown verbatim, never hidden — a future `tm_fuzzy_85` must
 * not look like a segment nobody touched.
 */
export function originBadge(origin: Origin | null): Badge | null {
  if (origin === null) return null;
  return (
    (ORIGIN_BADGE as Readonly<Record<string, Badge>>)[origin] ?? {
      text: origin,
      title: `Origin: ${origin}`,
    }
  );
}

const SEVERITY_RANK: Readonly<Record<QaSeverity, number>> = {
  info: 0,
  warning: 1,
  error: 2,
};

export interface QaMark {
  /** The worst undismissed severity. */
  readonly severity: QaSeverity;
  /** How many undismissed issues. */
  readonly count: number;
  /** Their messages, for the gutter's tooltip. */
  readonly messages: readonly string[];
}

/**
 * Each segment's QA mark, from its undismissed issues. A dismissed issue
 * does not colour the gutter — that is what dismissing is for — and a
 * segment whose every issue is dismissed has no mark.
 */
export function qaMarks(issues: readonly QaIssue[]): ReadonlyMap<number, QaMark> {
  const marks = new Map<number, QaMark>();
  for (const issue of issues) {
    if (issue.dismissed) continue;
    const prev = marks.get(issue.segmentId);
    marks.set(issue.segmentId, {
      severity:
        prev && SEVERITY_RANK[prev.severity] >= SEVERITY_RANK[issue.severity]
          ? prev.severity
          : issue.severity,
      count: (prev?.count ?? 0) + 1,
      messages: [...(prev?.messages ?? []), `${issue.rule}: ${issue.message}`],
    });
  }
  return marks;
}
