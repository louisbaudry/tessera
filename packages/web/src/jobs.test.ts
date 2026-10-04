import { ASSIGNMENT_STATUSES, CAPACITY_STATUSES } from '@cat-tool/vendor-core';
import { describe, expect, it } from 'vitest';

import {
  availableVerbs,
  CAPACITY_LABEL,
  CAPACITY_OPTIONS,
  noteChanged,
  FEED_GROUPS,
  formatDeadline,
  forecast,
  formatMicros,
  isWorkable,
  STATUS_LABEL,
  tierRows,
  TIER_LABEL,
  type RateEntry,
} from './jobs.js';

describe('availableVerbs', () => {
  it('offers exactly the answers the lifecycle allows a vendor, per status', () => {
    expect(availableVerbs('offered')).toEqual(['accept', 'decline']);
    expect(availableVerbs('pool_open')).toEqual(['claim']);
    expect(availableVerbs('claimed')).toEqual(['accept', 'decline']);
    expect(availableVerbs('accepted')).toEqual(['start']);
    expect(availableVerbs('in_progress')).toEqual(['deliver']);
  });

  it('offers nothing once the vendor’s part is over: delivered, reviewed, declined', () => {
    for (const s of ['delivered', 'reviewed', 'declined'] as const) {
      expect(availableVerbs(s), s).toEqual([]);
    }
  });

  it('says every status something, so a new one fails this typecheck and this test', () => {
    for (const s of ASSIGNMENT_STATUSES) expect(STATUS_LABEL[s], s).toMatch(/\w/);
  });

  it('puts a job in the editor only while it is the vendor’s to work on or has been delivered', () => {
    expect(ASSIGNMENT_STATUSES.filter(isWorkable)).toEqual([
      'accepted',
      'in_progress',
      'delivered',
    ]);
  });
});

describe('tierRows', () => {
  const card: RateEntry[] = [
    { src: 'en', tgt: 'de', tier: 'no_match', rateMicros: 80_000, currency: 'EUR' },
    { src: 'en', tgt: 'de', tier: 'exact', rateMicros: 8_000, currency: 'EUR' },
  ];

  it('is a row per tier that has words, in tier order, beside the vendor’s rate for it', () => {
    const rows = tierRows({ exact: 50, no_match: 100 }, card);
    expect(rows.map((r) => [r.tier, r.words, r.rate?.rateMicros])).toEqual([
      ['no_match', 100, 80_000],
      ['exact', 50, 8_000],
    ]);
    expect(rows[0]!.label).toBe(TIER_LABEL.no_match);
  });

  it('has a null rate, never a zero one, for a tier the card does not price', () => {
    const [row] = tierRows({ ice: 5 }, card);
    expect(row).toMatchObject({ tier: 'ice', words: 5, rate: null });
  });

  it('skips tiers with no words, and carries no amount or total (decision 10)', () => {
    const rows = tierRows({ no_match: 0, fuzzy_85_94: 12 }, card);
    expect(rows.map((r) => r.tier)).toEqual(['fuzzy_85_94']);
    expect(JSON.stringify(rows)).not.toMatch(/amount|total/i);
  });
});

describe('money and deadline', () => {
  it('writes micros as money, keeping a sub-cent rate legible', () => {
    expect(formatMicros(80_000, 'EUR', 'en')).toBe('€0.08');
    expect(formatMicros(8_000, 'EUR', 'en')).toBe('€0.008');
    expect(formatMicros(12_500_000, 'USD', 'en')).toBe('$12.50');
  });

  it('writes a deadline, or says there is none, or falls back to the text it was given', () => {
    expect(formatDeadline(null)).toBe('No deadline');
    expect(formatDeadline('2026-03-10T17:00:00.000Z', 'en', 'UTC')).toMatch(
      /Mar 10, 2026/,
    );
    expect(formatDeadline('not a date')).toBe('not a date');
  });

  it('lists the four feed groups with the answer-needed one first', () => {
    expect(FEED_GROUPS.map((g) => g.key)).toEqual([
      'needsResponse',
      'claimable',
      'active',
      'delivered',
    ]);
  });
});

describe('forecast', () => {
  const rate = (
    tier: RateEntry['tier'],
    rateMicros: number,
    currency = 'EUR',
  ): RateEntry => ({
    src: 'en',
    tgt: 'de',
    tier,
    rateMicros,
    currency,
  });

  it('prices the offer’s words at the offer’s rates', () => {
    const f = forecast({ no_match: 100, exact: 50 }, [
      rate('no_match', 80_000),
      rate('exact', 20_000),
    ]);
    expect(f).toEqual({ currency: 'EUR', totalMicros: 9_000_000, unpricedWords: 0 });
  });

  it('leaves out words with no rate and says how many, never pricing them at zero', () => {
    const f = forecast({ no_match: 100, exact: 50 }, [rate('no_match', 80_000)]);
    expect(f).toEqual({ currency: 'EUR', totalMicros: 8_000_000, unpricedWords: 50 });
  });

  it('is null when nothing is priced or the card spans two currencies', () => {
    expect(forecast({ no_match: 10 }, [])).toBeNull();
    expect(
      forecast({ no_match: 10, exact: 10 }, [
        rate('no_match', 80_000),
        rate('exact', 20_000, 'USD'),
      ]),
    ).toBeNull();
  });
});

describe('capacity', () => {
  it('has a label for every status, offered in the vendor-core order', () => {
    expect([...CAPACITY_OPTIONS]).toEqual([...CAPACITY_STATUSES]);
    for (const status of CAPACITY_STATUSES) expect(CAPACITY_LABEL[status]).toBeTruthy();
  });

  it('counts a note as changed only when its trimmed text differs from the saved one', () => {
    expect(noteChanged('  Back Monday ', 'Back Monday')).toBe(false);
    expect(noteChanged('', null)).toBe(false);
    expect(noteChanged('   ', null)).toBe(false);
    expect(noteChanged('x', null)).toBe(true);
    expect(noteChanged('', 'Back Monday')).toBe(true);
  });
});
