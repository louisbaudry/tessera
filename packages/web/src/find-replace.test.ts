import { describe, expect, it } from 'vitest';

import {
  allTicked,
  applyLabel,
  applySummary,
  chosenFor,
  describeJob,
  formProblem,
  isFinished,
  isReplaceKey,
  scanSummary,
  toggled,
  EMPTY_FORM,
  type ReplaceApplyResult,
  type ReplaceJob,
  type ReplaceProposalView,
  type ReplaceScanResult,
} from './find-replace.js';

const proposal = (id: number, count = 1): ReplaceProposalView => ({
  segmentId: id,
  fileId: 1,
  ord: id,
  updatedAt: `t${id}`,
  status: 'translated',
  before: 'a',
  after: 'b',
  ranges: [],
  count,
});
const scan = (over: Partial<ReplaceScanResult> = {}): ReplaceScanResult => ({
  proposals: [],
  scanned: 0,
  locked: 0,
  truncated: false,
  ...over,
});
const job = (over: Partial<ReplaceJob<unknown>> = {}): ReplaceJob<unknown> => ({
  id: 'j',
  kind: 'replace',
  tm: 'p',
  state: 'running',
  progress: null,
  result: null,
  error: null,
  ...over,
});

describe('describeJob', () => {
  it('says what a running job is doing, with its progress when it has one', () => {
    expect(describeJob(job(), 'search')).toBe('Searching…');
    expect(describeJob(job(), 'replace')).toBe('Replacing…');
    expect(
      describeJob(
        job({ progress: { stage: 'searching', fraction: 0.456, units: 50 } }),
        'search',
      ),
    ).toBe('Searching… 45%');
  });

  it('says a failure in the server’s words, and that a cancelled replace changed nothing', () => {
    expect(
      describeJob(
        job({ state: 'failed', error: 'the pattern took too long: simplify it' }),
        'search',
      ),
    ).toBe('the pattern took too long: simplify it');
    expect(describeJob(job({ state: 'failed' }), 'replace')).toBe('The replace failed.');
    expect(describeJob(job({ state: 'cancelled' }), 'replace')).toBe(
      'Replace cancelled: nothing was changed.',
    );
    expect(isFinished(job())).toBe(false);
    expect(isFinished(job({ state: 'done' }))).toBe(true);
  });
});

describe('scanSummary', () => {
  it('counts segments and matches', () => {
    expect(scanSummary(scan({ proposals: [proposal(1, 2), proposal(2, 1)] }))).toBe(
      '2 segments would change (3 matches).',
    );
    expect(scanSummary(scan({ proposals: [proposal(1)] }))).toBe(
      '1 segment would change (1 match).',
    );
  });

  it('says no segment matches, and that locked ones were not searched, since that is not "clean"', () => {
    expect(scanSummary(scan())).toBe('No segment matches.');
    expect(scanSummary(scan({ locked: 2 }))).toBe(
      'No segment matches. 2 locked segments were not searched.',
    );
  });

  it('says plainly when a run is capped', () => {
    expect(scanSummary(scan({ proposals: [proposal(1)], truncated: true }))).toMatch(
      /Run it again for the rest/,
    );
  });
});

describe('applySummary', () => {
  const result = (over: Partial<ReplaceApplyResult> = {}): ReplaceApplyResult => ({
    segments: 0,
    matches: 0,
    stale: 0,
    locked: 0,
    unchanged: 0,
    batchId: null,
    ...over,
  });

  it('says what was written, and that those segments need confirming again', () => {
    expect(applySummary(result({ segments: 2, matches: 3 }))).toBe(
      'Replaced 3 matches in 2 segments. They are translated again and need confirming.',
    );
  });

  it('says what was left alone and why', () => {
    expect(
      applySummary(
        result({ segments: 1, matches: 1, stale: 2, locked: 1, unchanged: 1 }),
      ),
    ).toBe(
      'Replaced 1 match in 1 segment. They are translated again and need confirming. ' +
        'Left alone: 2 segments changed since the preview, 1 segment locked, ' +
        '1 segment the replacement left as it was.',
    );
    expect(applySummary(result({ stale: 1 }))).toBe(
      'Nothing was replaced. Left alone: 1 segment changed since the preview.',
    );
    expect(applySummary(result())).toBe('Nothing was replaced.');
  });
});

describe('ticking', () => {
  const proposals = [proposal(5), proposal(6), proposal(7)];

  it('starts with every segment ticked, and one click turns one off and on', () => {
    const all = allTicked(proposals);
    expect([...all]).toEqual([5, 6, 7]);
    const off = toggled(all, 6);
    expect([...off]).toEqual([5, 7]);
    expect([...toggled(off, 6)].sort()).toEqual([5, 6, 7]);
    // The original is not changed.
    expect(all.size).toBe(3);
  });

  it('sends the ticked segments with the version each had in the preview, in the preview’s order', () => {
    expect(chosenFor(proposals, new Set([7, 5]))).toEqual([
      { segmentId: 5, updatedAt: 't5' },
      { segmentId: 7, updatedAt: 't7' },
    ]);
    expect(chosenFor(proposals, new Set())).toEqual([]);
  });

  it('labels the button for how many are ticked', () => {
    expect(applyLabel(1)).toBe('Replace in 1 segment');
    expect(applyLabel(1200)).toBe('Replace in 1,200 segments');
  });
});

describe('formProblem', () => {
  it('needs something to find, and nothing else from the page', () => {
    expect(formProblem(EMPTY_FORM)).toBe('Type what to find.');
    expect(formProblem({ ...EMPTY_FORM, pattern: 'x' })).toBeNull();
  });
});

describe('isReplaceKey', () => {
  const key = {
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
    code: 'KeyH',
  };
  it('is Ctrl+Shift+H and nothing else', () => {
    expect(isReplaceKey(key)).toBe(true);
    expect(isReplaceKey({ ...key, shiftKey: false })).toBe(false);
    expect(isReplaceKey({ ...key, ctrlKey: false })).toBe(false);
    expect(isReplaceKey({ ...key, metaKey: true })).toBe(false);
    expect(isReplaceKey({ ...key, code: 'KeyL' })).toBe(false);
  });
});
