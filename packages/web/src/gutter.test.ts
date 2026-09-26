import type { QaIssue } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import { originBadge, qaMarks, statusOf } from './gutter.js';

let nextId = 1;
const issue = (
  segmentId: number,
  severity: QaIssue['severity'],
  dismissed = false,
): QaIssue => ({
  id: nextId++,
  segmentId,
  rule: 'seg.empty',
  severity,
  message: `${severity} on ${segmentId}`,
  dismissed,
  runAt: '2026-09-25T00:00:00.000Z',
});

describe('qaMarks', () => {
  it('keeps the worst undismissed severity and counts only undismissed issues', () => {
    const marks = qaMarks([
      issue(1, 'info'),
      issue(1, 'error'),
      issue(1, 'warning'),
      issue(2, 'error', true),
      issue(2, 'warning'),
    ]);
    expect(marks.get(1)).toMatchObject({ severity: 'error', count: 3 });
    expect(marks.get(1)!.messages).toHaveLength(3);
    expect(marks.get(2)).toMatchObject({ severity: 'warning', count: 1 });
  });

  it('gives no mark to a segment whose every issue is dismissed', () => {
    expect(qaMarks([issue(3, 'error', true)]).has(3)).toBe(false);
  });
});

describe('originBadge', () => {
  it('abbreviates the origins it knows', () => {
    expect(originBadge('tm_exact')?.text).toBe('TM');
    expect(originBadge('tm_exact_tagdiff')?.text).toBe('TM\u2260');
  });

  it('shows an origin it does not know verbatim, and nothing for none', () => {
    expect(originBadge('tm_fuzzy_85')).toEqual({
      text: 'tm_fuzzy_85',
      title: 'Origin: tm_fuzzy_85',
    });
    expect(originBadge(null)).toBeNull();
  });
});

describe('statusOf', () => {
  it('shows a locked segment as locked whatever its status', () => {
    expect(statusOf({ status: 'new', locked: true })).toBe('locked');
    expect(statusOf({ status: 'draft', locked: false })).toBe('draft');
  });
});
