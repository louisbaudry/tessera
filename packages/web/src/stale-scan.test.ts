import { describe, expect, it } from 'vitest';

import {
  describeScan,
  pairChoices,
  pairKey,
  rowFinding,
  scanSummary,
  type ScanJob,
  type StaleRowView,
  type StaleScanResult,
} from './stale-scan.js';

const result = (over: Partial<StaleScanResult> = {}): StaleScanResult => ({
  entries: 3,
  scanned: 30_000,
  total: 2,
  rows: [],
  truncated: false,
  complete: true,
  ...over,
});
const job = (over: Partial<ScanJob>): ScanJob => ({
  id: 'j',
  kind: 'scan',
  tm: 'mem',
  state: 'running',
  progress: null,
  result: null,
  error: null,
  ...over,
});

describe('scanSummary', () => {
  it('says what was found, in what was read', () => {
    expect(scanSummary(result())).toBe(
      '2 uses of an old or forbidden rendering in 30,000 units read.',
    );
    expect(scanSummary(result({ total: 1, scanned: 1 }))).toBe(
      '1 use of an old or forbidden rendering in 1 unit read.',
    );
  });

  it('says plainly that none were found, only when it looked', () => {
    expect(scanSummary(result({ total: 0 }))).toBe(
      'No unit uses an old rendering — 30,000 units read.',
    );
  });

  it('never calls a memory clean when the glossary had nothing to check against', () => {
    const empty = result({ entries: 0, scanned: 0, total: 0 });
    expect(scanSummary(empty, { srcLang: 'fr', tgtLang: 'it' })).toMatch(
      /no terms for fr → it, so there is nothing to check/,
    );
    expect(scanSummary(empty)).not.toMatch(/No unit/);
  });

  it('says when the list is a page of a larger count, and when the scan stopped early', () => {
    const rows = Array.from({ length: 500 }, () => ({}) as StaleRowView);
    expect(scanSummary(result({ total: 12_431, rows, truncated: true }))).toBe(
      '12,431 uses of an old or forbidden rendering in 30,000 units read. Showing the first 500.',
    );
    expect(scanSummary(result({ complete: false, scanned: 4_000 }))).toContain(
      'stopped early: the rest was not read',
    );
  });
});

describe('describeScan', () => {
  it('shows progress while running, the report when done, and a plain line otherwise', () => {
    expect(describeScan(job({}))).toBe('Starting…');
    expect(
      describeScan(
        job({ progress: { stage: 'scanning', fraction: 0.426, units: 12_345 } }),
      ),
    ).toBe('Scanning… 42% · 12,345 units');
    expect(
      describeScan(job({ progress: { stage: 'scanning', fraction: null, units: null } })),
    ).toBe('Scanning…');
    expect(describeScan(job({ state: 'done', result: result({ total: 0 }) }))).toMatch(
      /^No unit/,
    );
    expect(describeScan(job({ state: 'cancelled' }))).toBe('Scan cancelled.');
    expect(describeScan(job({ state: 'failed', error: 'the scan failed' }))).toBe(
      'the scan failed',
    );
  });

  it('clamps a fraction past its range', () => {
    expect(
      describeScan(job({ progress: { stage: 's', fraction: 1.2, units: 1 } })),
    ).toContain('100%');
  });
});

describe('rowFinding', () => {
  const row = (over: Partial<StaleRowView>): StaleRowView => ({
    tuUuid: 'u',
    source: 's',
    target: 't',
    termId: 1,
    term: 'account',
    kind: 'missing_preferred',
    preferred: 'Konto',
    found: 'Zugang',
    ...over,
  });

  it('names what the target uses and what the glossary prefers now', () => {
    expect(rowFinding(row({}))).toBe('uses “Zugang”; prefers “Konto”');
    expect(rowFinding(row({ kind: 'forbidden', found: 'Account' }))).toBe(
      'uses the forbidden “Account”; prefers “Konto”',
    );
  });

  it('says only what is forbidden when the term has no preferred rendering', () => {
    expect(
      rowFinding(row({ kind: 'forbidden', found: 'Account', preferred: null })),
    ).toBe('uses the forbidden “Account”');
  });
});

describe('pairChoices', () => {
  it('offers each ordered pair of a memory’s languages', () => {
    expect(pairChoices(['en', 'de']).map(pairKey)).toEqual(['en>de', 'de>en']);
    expect(pairChoices(['en', 'de', 'fr']).map(pairKey)).toEqual([
      'en>de',
      'en>fr',
      'de>en',
      'de>fr',
      'fr>en',
      'fr>de',
    ]);
  });

  it('offers none for a memory with fewer than two languages', () => {
    expect(pairChoices([])).toEqual([]);
    expect(pairChoices(['en'])).toEqual([]);
  });
});
