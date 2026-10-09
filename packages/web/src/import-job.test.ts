import { describe, expect, it } from 'vitest';

import {
  describeJob,
  findRunning,
  isFinished,
  percent,
  type ImportJob,
} from './import-job.js';

const job = (over: Partial<ImportJob> = {}): ImportJob => ({
  id: 'j',
  kind: 'import',
  tm: 'legal',
  state: 'running',
  progress: null,
  result: null,
  error: null,
  ...over,
});

describe('percent', () => {
  it('is a whole number, floored and clamped', () => {
    expect(percent(0)).toBe(0);
    expect(percent(0.426)).toBe(42);
    expect(percent(1)).toBe(100);
    expect(percent(1.0004)).toBe(100);
    expect(percent(-0.2)).toBe(0);
  });

  it('is null when the operation cannot say', () => {
    expect(percent(null)).toBeNull();
    expect(percent(Number.NaN)).toBeNull();
  });
});

describe('describeJob', () => {
  it('says it is starting before the first report', () => {
    expect(describeJob(job())).toBe('Starting…');
  });

  it('shows the percentage and the units written so far', () => {
    expect(
      describeJob(job({ progress: { stage: 'importing', fraction: 0.5, units: 12000 } })),
    ).toBe(`Importing… 50% · ${(12000).toLocaleString()} units`);
  });

  it('still shows a running job that cannot say how far it is', () => {
    expect(
      describeJob(job({ progress: { stage: 'importing', fraction: null, units: null } })),
    ).toBe('Importing…');
  });

  it('says a cancelled import kept nothing, and shows a failure as the server worded it', () => {
    expect(describeJob(job({ state: 'cancelled' }))).toBe(
      'Import cancelled — nothing was kept.',
    );
    expect(describeJob(job({ state: 'failed', error: 'not a TMX file' }))).toBe(
      'not a TMX file',
    );
    expect(describeJob(job({ state: 'failed' }))).toBe('The import failed.');
  });
});

describe('isFinished', () => {
  it('is everything but running', () => {
    expect(isFinished(job())).toBe(false);
    for (const state of ['done', 'failed', 'cancelled'] as const) {
      expect(isFinished(job({ state }))).toBe(true);
    }
  });
});

describe('findRunning', () => {
  it('is the running import, not a finished one', () => {
    const done = job({ id: 'a', state: 'done' });
    const running = job({ id: 'b' });
    expect(findRunning([done, running])).toBe(running);
    expect(findRunning([done, job({ id: 'c', state: 'failed' })])).toBeNull();
    expect(findRunning([])).toBeNull();
  });

  it('does not take a running scan for an import (backlog #122)', () => {
    const scan = { kind: 'scan', state: 'running' };
    const running = job({ id: 'b' });
    expect(findRunning([scan])).toBeNull();
    expect(findRunning([scan, running])).toBe(running);
  });
});
