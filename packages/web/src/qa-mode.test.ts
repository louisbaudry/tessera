import { describe, expect, it } from 'vitest';

import {
  afterEdit,
  afterSweep,
  canRunQa,
  describeSweep,
  LIVE_QA,
  modeLine,
  type QaSweepJob,
} from './qa-mode.js';

const job = (over: Partial<QaSweepJob> = {}): QaSweepJob => ({
  id: 'j1',
  kind: 'qa',
  state: 'running',
  progress: null,
  result: null,
  error: null,
  ...over,
});
const deferred = { deferred: true, stale: false, unsweptEdits: 0 };

describe('the mode a page holds', () => {
  it('a live project never reads as stale, whatever is saved', () => {
    expect(afterEdit(LIVE_QA)).toEqual(LIVE_QA);
  });

  it('a deferred one is stale from its first save, and counts them', () => {
    const once = afterEdit(deferred);
    expect(once).toEqual({ deferred: true, stale: true, unsweptEdits: 1 });
    expect(afterEdit(once).unsweptEdits).toBe(2);
  });

  it('a sweep clears it only when the server says current and nothing was saved since it began', () => {
    const stale = afterEdit(deferred);
    expect(afterSweep(stale, { segments: 10, current: true }, 1)).toEqual(deferred);
    expect(afterSweep(stale, { segments: 10, current: false }, 1)).toEqual(stale);
  });

  it('an edit saved while the sweep ran keeps the page stale, even if the server said current', () => {
    const startedAt = afterEdit(deferred); // one unswept edit when the sweep began
    const editedMeanwhile = afterEdit(startedAt); // two by the time it ended
    const out = afterSweep(editedMeanwhile, { segments: 10, current: true }, 1);
    expect(out).toEqual(editedMeanwhile);
    expect(out.stale).toBe(true);
  });

  it('offers Run QA only to a deferred project', () => {
    expect(canRunQa(LIVE_QA)).toBe(false);
    expect(canRunQa(deferred)).toBe(true);
  });
});

describe('modeLine', () => {
  it('says nothing for live QA, and says when deferred findings are out of date', () => {
    expect(modeLine(LIVE_QA)).toBeNull();
    expect(modeLine(deferred)).toMatch(/current/);
    expect(modeLine(afterEdit(deferred))).toMatch(/out of date/);
  });
});

describe('describeSweep', () => {
  it('shows a percentage when there is one, and a plain wait when there is not', () => {
    expect(
      describeSweep(job({ progress: { stage: 'checking', fraction: 0.456, units: 4 } })),
    ).toBe('Running QA… 45%');
    expect(describeSweep(job())).toBe('Running QA…');
    expect(
      describeSweep(
        job({ progress: { stage: 'checking', fraction: Number.NaN, units: 0 } }),
      ),
    ).toBe('Running QA…');
  });

  it('says what finished, and warns when an edit landed meanwhile', () => {
    expect(
      describeSweep(job({ state: 'done', result: { segments: 1200, current: true } })),
    ).toBe('QA checked 1,200 segments.');
    expect(
      describeSweep(job({ state: 'done', result: { segments: 1, current: false } })),
    ).toMatch(/1 segment, but you edited meanwhile/);
  });

  it('uses the server’s words for a failure, else its own', () => {
    expect(
      describeSweep(job({ state: 'failed', error: 'the QA run failed: try again' })),
    ).toBe('the QA run failed: try again');
    expect(describeSweep(job({ state: 'failed' }))).toBe('The QA run failed.');
    expect(describeSweep(job({ state: 'cancelled' }))).toBe('QA cancelled.');
  });
});
