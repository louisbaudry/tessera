import { describe, expect, it } from 'vitest';

import {
  canBeLate,
  isReminderLead,
  nextNoticeTime,
  noticesDue,
  noticeTimes,
  type DeadlineRow,
} from './deadline.js';

const H = 3_600_000;
const t = (iso: string) => Date.parse(iso);
const row = (over: Partial<DeadlineRow> = {}): DeadlineRow => ({
  status: 'accepted',
  deadline: '2026-10-10T12:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const none = new Set<never>();

describe('canBeLate', () => {
  it('is true before delivery and false for delivered, reviewed and declined', () => {
    for (const s of [
      'offered',
      'pool_open',
      'claimed',
      'accepted',
      'in_progress',
    ] as const) {
      expect(canBeLate(s)).toBe(true);
    }
    for (const s of ['delivered', 'reviewed', 'declined'] as const) {
      expect(canBeLate(s)).toBe(false);
    }
  });
});

describe('isReminderLead', () => {
  it('takes whole hours from 0 to 720', () => {
    expect([0, 1, 24, 720].every(isReminderLead)).toBe(true);
    expect([-1, 721, 1.5, NaN, '24', null].some(isReminderLead)).toBe(false);
  });
});

describe('noticeTimes', () => {
  it('puts the reminder `lead` hours before the deadline and overdue at it', () => {
    const times = noticeTimes(row(), 24);
    expect(times.overdue).toBe(t('2026-10-10T12:00:00.000Z'));
    expect(times.deadline_soon).toBe(t('2026-10-10T12:00:00.000Z') - 24 * H);
  });

  it('has no reminder when the lead is off, but still has overdue', () => {
    expect(noticeTimes(row(), 0)).toEqual({
      deadline_soon: null,
      overdue: t('2026-10-10T12:00:00.000Z'),
    });
  });

  it('skips the reminder for a job created inside its own lead window', () => {
    const late = row({ createdAt: '2026-10-10T08:00:00.000Z' });
    expect(noticeTimes(late, 24).deadline_soon).toBeNull();
    expect(noticeTimes(late, 24).overdue).not.toBeNull();
  });

  it('has nothing for a job with no deadline or one already delivered', () => {
    const nothing = { deadline_soon: null, overdue: null };
    expect(noticeTimes(row({ deadline: null }), 24)).toEqual(nothing);
    expect(noticeTimes(row({ status: 'delivered' }), 24)).toEqual(nothing);
    expect(noticeTimes(row({ status: 'declined' }), 24)).toEqual(nothing);
  });

  it('ignores a deadline that does not parse rather than throwing', () => {
    expect(noticeTimes(row({ deadline: 'soon' }), 24)).toEqual({
      deadline_soon: null,
      overdue: null,
    });
  });
});

describe('noticesDue', () => {
  const lead = 24;
  it('is empty before the window, the reminder inside it, both after the deadline', () => {
    expect(noticesDue(row(), lead, t('2026-10-09T11:59:59.000Z'), none)).toEqual([]);
    expect(noticesDue(row(), lead, t('2026-10-09T12:00:00.000Z'), none)).toEqual([
      'deadline_soon',
    ]);
    expect(noticesDue(row(), lead, t('2026-10-10T12:00:00.000Z'), none)).toEqual([
      'deadline_soon',
      'overdue',
    ]);
  });

  it('leaves out what has fired', () => {
    const fired = new Set(['deadline_soon'] as const);
    expect(noticesDue(row(), lead, t('2026-10-11T00:00:00.000Z'), fired)).toEqual([
      'overdue',
    ]);
  });

  it('stops once the job is delivered, even past the deadline', () => {
    expect(
      noticesDue(row({ status: 'delivered' }), lead, t('2026-10-11T00:00:00.000Z'), none),
    ).toEqual([]);
  });
});

describe('nextNoticeTime', () => {
  it('is the reminder first, then overdue, then null once both have fired', () => {
    expect(nextNoticeTime(row(), 24, none)).toBe(t('2026-10-09T12:00:00.000Z'));
    expect(nextNoticeTime(row(), 24, new Set(['deadline_soon']))).toBe(
      t('2026-10-10T12:00:00.000Z'),
    );
    expect(nextNoticeTime(row(), 24, new Set(['deadline_soon', 'overdue']))).toBeNull();
  });
});
