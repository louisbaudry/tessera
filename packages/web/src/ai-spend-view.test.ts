import { describe, expect, it } from 'vitest';

import {
  appendPage,
  callOutcome,
  callTime,
  engineLabel,
  outcomeSummary,
  unitsLabel,
  type CallRow,
  type SpendRow,
} from './ai-spend-view.js';

const row = (over: Partial<SpendRow> = {}): SpendRow => ({
  engine: 'tessera',
  model: 'm-1',
  unit: 'tokens',
  calls: 10,
  inputUnits: 12345,
  outputUnits: 2000,
  stored: 8,
  rejected: 1,
  discarded: 1,
  ...over,
});

describe('engineLabel', () => {
  it('names both engines, and the model beside the first', () => {
    expect(engineLabel('deepl', 'deepl-v2')).toBe('DeepL');
    expect(engineLabel('tessera', 'm-1')).toBe('Tessera engine (m-1)');
  });
});

describe('unitsLabel', () => {
  it('shows input and output tokens, grouped, with the unit named', () => {
    expect(unitsLabel(row())).toBe('12,345 in, 2,000 out tokens');
  });

  it('shows DeepL’s characters as one count, since it reports no output', () => {
    expect(
      unitsLabel(
        row({ engine: 'deepl', unit: 'characters', inputUnits: 3000, outputUnits: 0 }),
      ),
    ).toBe('3,000 characters');
  });
});

describe('outcomeSummary', () => {
  it('says how many replies were kept, and names the paid-for ones that were not', () => {
    expect(outcomeSummary(row())).toBe('8 of 10 kept, 1 refused, 1 dropped');
  });

  it('says nothing extra when every reply was kept', () => {
    expect(outcomeSummary(row({ calls: 3, stored: 3, rejected: 0, discarded: 0 }))).toBe(
      '3 of 3 kept',
    );
  });

  it('counts a single reply plainly', () => {
    expect(outcomeSummary(row({ calls: 1, stored: 0, rejected: 1, discarded: 0 }))).toBe(
      '0 of 1 kept, 1 refused',
    );
  });
});

const call = (id: number, over: Partial<CallRow> = {}): CallRow => ({
  id,
  segmentId: id,
  engine: 'tessera',
  model: 'm-1',
  unit: 'tokens',
  inputUnits: 10,
  outputUnits: 2,
  outcome: 'stored',
  at: '2026-11-01T14:05:09.123Z',
  ...over,
});

describe('the per-call log', () => {
  it('names each outcome as the summary does', () => {
    expect(callOutcome('stored')).toBe('Kept');
    expect(callOutcome('rejected')).toBe('Refused');
    expect(callOutcome('discarded')).toBe('Dropped');
  });

  it('shows a reply’s time to the minute in UTC, and an odd stamp as it is', () => {
    expect(callTime('2026-11-01T14:05:09.123Z')).toBe('2026-11-01 14:05 UTC');
    expect(callTime('yesterday')).toBe('yesterday');
  });

  it('appends an older page and never shows a row twice', () => {
    const shown = [call(5), call(4)];
    expect(
      appendPage(shown, { calls: [call(4), call(3)], next: null }).map((c) => c.id),
    ).toEqual([5, 4, 3]);
  });
});
