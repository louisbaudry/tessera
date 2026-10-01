import type { QaIssue, QaRule, QaSeverity } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import {
  NO_FILTER,
  panelCounts,
  panelIssues,
  toggleSeverity,
  withIssue,
  type PanelFilter,
} from './qa-panel.js';

let nextId = 1;
const issue = (
  segmentId: number,
  rule: QaRule,
  severity: QaSeverity,
  dismissed = false,
): QaIssue => ({
  id: nextId++,
  segmentId,
  rule,
  severity,
  message: `${rule} on ${segmentId}`,
  dismissed,
  runAt: '2026-10-01T00:00:00.000Z',
});

// Segment 30 comes first in the file, then 10, then 20: ids are not order.
const positions = new Map([
  [30, 0],
  [10, 1],
  [20, 2],
]);

const issues = [
  issue(10, 'punct.terminal', 'warning'),
  issue(10, 'tag.missing', 'error'),
  issue(20, 'consistency.source_differs', 'info'),
  issue(30, 'num.missing', 'error', true),
  issue(30, 'punct.spacing', 'warning'),
  issue(99, 'seg.empty', 'error'), // a segment of another file
];
const [terminal, missing, sourceDiffers, dismissed, spacing] = issues;

const filter = (f: Partial<PanelFilter>): PanelFilter => ({ ...NO_FILTER, ...f });

describe('panelIssues', () => {
  it('lists in document order, worst first within a segment, dismissed hidden', () => {
    expect(panelIssues(issues, positions, NO_FILTER)).toEqual([
      spacing,
      missing,
      terminal,
      sourceDiffers,
    ]);
  });

  it('shows dismissed findings on request, in their place', () => {
    expect(panelIssues(issues, positions, filter({ showDismissed: true }))).toEqual([
      dismissed,
      spacing,
      missing,
      terminal,
      sourceDiffers,
    ]);
  });

  it('filters by severity and by rule, together', () => {
    const warnings = filter({ severities: new Set(['warning']) });
    expect(panelIssues(issues, positions, warnings)).toEqual([spacing, terminal]);
    expect(
      panelIssues(issues, positions, { ...warnings, rule: 'punct.terminal' }),
    ).toEqual([terminal]);
    expect(
      panelIssues(issues, positions, filter({ severities: new Set(['error', 'info']) })),
    ).toEqual([missing, sourceDiffers]);
  });
});

describe('panelCounts', () => {
  it("counts each facet under the other's choice, and dismissed ones apart", () => {
    const counts = panelCounts(issues, positions, filter({ rule: 'punct.terminal' }));
    expect(counts.bySeverity).toEqual({ error: 0, warning: 1, info: 0 });
    // Rules are counted across every severity, in §6.4's order.
    expect([...counts.byRule]).toEqual([
      ['tag.missing', 1],
      ['consistency.source_differs', 1],
      ['punct.terminal', 1],
      ['punct.spacing', 1],
    ]);
    expect(counts.dismissed).toBe(1);

    const errors = panelCounts(
      issues,
      positions,
      filter({ severities: new Set(['error']), showDismissed: true }),
    );
    expect([...errors.byRule]).toEqual([
      ['tag.missing', 1],
      ['num.missing', 1],
    ]);
    expect(errors.bySeverity).toEqual({ error: 2, warning: 2, info: 1 });
  });
});

describe('toggleSeverity', () => {
  it('adds a severity, and takes it out again', () => {
    const one = toggleSeverity(new Set(), 'error');
    expect([...one]).toEqual(['error']);
    expect([...toggleSeverity(one, 'error')]).toEqual([]);
  });
});

describe('withIssue', () => {
  it('replaces the finding with the same segment and rule, whatever its id', () => {
    const answer = { ...missing!, id: 999, dismissed: true };
    expect(withIssue(issues, answer)).toEqual(
      issues.map((i) => (i === missing ? answer : i)),
    );
  });

  it('does not bring back a finding QA has since cleared', () => {
    const cleared = issues.filter((i) => i !== missing);
    expect(withIssue(cleared, { ...missing!, dismissed: true })).toEqual(cleared);
  });
});
