import type { GlossaryMismatch, Segment } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import {
  cardActions,
  confirmState,
  footerText,
  glossaryNameInput,
  idsByOrd,
  latestVersion,
  canRecordException,
  mismatchText,
  proposalText,
  occurrenceText,
  stateText,
  type FlagView,
} from './glossary-panel.js';

const flag = (over: Partial<FlagView> = {}): FlagView => ({
  key: 'invoice',
  term: 'invoice',
  termId: null,
  offered: [],
  occurrences: 11,
  ords: [1, 4, 9],
  state: { state: 'flagged' },
  ...over,
});

describe('occurrenceText', () => {
  it('says how often and in how many segments', () => {
    expect(occurrenceText(flag())).toBe('repeated 11 times, in 3 segments');
    expect(occurrenceText(flag({ occurrences: 1, ords: [2] }))).toBe(
      'repeated once, in 1 segment',
    );
    expect(occurrenceText(flag({ ords: [] }))).toBe('repeated 11 times');
  });
});

describe('cardActions', () => {
  it('offers edits only on an entry that exists, and only of renderings on offer', () => {
    expect(cardActions(flag({ termId: null, offered: ['a'] }))).toEqual({
      canEdit: false,
      deprecatable: [],
    });
    expect(cardActions(flag({ termId: 3, offered: ['a', 'b'] }))).toEqual({
      canEdit: true,
      deprecatable: ['a', 'b'],
    });
  });
});

describe('stateText', () => {
  it('is null while undecided and names what was picked after', () => {
    expect(stateText({ state: 'flagged' })).toBeNull();
    expect(stateText({ state: 'decided', rendering: 'Rechnung', kind: 'custom' })).toBe(
      'Chose “Rechnung”',
    );
    expect(
      stateText({ state: 'proposed', rendering: 'Faktura', edit: 'deprecate' }),
    ).toBe('Will deprecate “Faktura”');
    expect(stateText({ state: 'proposed', rendering: 'Beleg', edit: 'override' })).toBe(
      'Will override with “Beleg”',
    );
    expect(stateText({ state: 'skipped' })).toBe('Skipped');
  });
});

describe('footerText', () => {
  it('counts what would be written and warns that skipped terms return', () => {
    expect(footerText({ flagged: 3, decided: 3, proposed: 1, skipped: 2 })).toBe(
      '4 decisions, 2 skipped — skipped terms are asked again next time',
    );
    expect(footerText({ flagged: 0, decided: 1, proposed: 0, skipped: 0 })).toBe(
      '1 decision',
    );
  });
});

describe('confirmState', () => {
  const some = { flagged: 0, decided: 2, proposed: 0, skipped: 0 };
  it('is enabled with decisions and a write target', () => {
    expect(confirmState(some, 'acme')).toEqual({ enabled: true, reason: null });
  });
  it('explains itself with no write target, before anything else', () => {
    const state = confirmState({ ...some, decided: 0 }, null);
    expect(state.enabled).toBe(false);
    expect(state.reason).toMatch(/no glossary/);
  });
  it('is disabled with nothing decided', () => {
    expect(confirmState({ ...some, decided: 0 }, 'acme')).toEqual({
      enabled: false,
      reason: 'Nothing is decided yet.',
    });
  });
});

describe('latestVersion', () => {
  const seg = (id: number, updatedAt: string) => ({ id, ord: id, updatedAt }) as Segment;
  it('moves when any segment is written, and when the count changes', () => {
    const a = [seg(1, '2026-10-01T00:00:00.000Z'), seg(2, '2026-10-01T00:00:00.000Z')];
    const edited = [a[0]!, seg(2, '2026-10-02T00:00:00.000Z')];
    expect(latestVersion(edited)).not.toBe(latestVersion(a));
    expect(latestVersion(a.slice(0, 1))).not.toBe(latestVersion(a));
    expect(latestVersion([])).toBe('0:');
  });
});

describe('idsByOrd', () => {
  it('maps what the server names by ord to the id the grid jumps by', () => {
    const segs = [
      { id: 40, ord: 0 },
      { id: 41, ord: 1 },
    ] as Segment[];
    expect(idsByOrd(segs).get(1)).toBe(41);
  });
});

describe('mismatchText', () => {
  const base: GlossaryMismatch = {
    ord: 0,
    segmentId: 1,
    termId: 1,
    term: 'invoice',
    kind: 'missing_preferred',
    preferred: 'Rechnung',
    found: null,
  };
  it('says what the target does instead', () => {
    expect(mismatchText(base)).toBe('does not use “Rechnung”');
    expect(mismatchText({ ...base, found: 'Beleg' })).toBe(
      'uses “Beleg”, not “Rechnung”',
    );
    expect(mismatchText({ ...base, kind: 'forbidden', found: 'Faktura' })).toBe(
      'uses “Faktura”, which the glossary forbids',
    );
  });
});

describe('glossaryNameInput', () => {
  it('trims and lower-cases what a person typed', () => {
    expect(glossaryNameInput('  Acme ')).toBe('acme');
  });
});

describe('exceptions (#110)', () => {
  const row = (over: Partial<GlossaryMismatch>): GlossaryMismatch => ({
    ord: 0,
    segmentId: 1,
    termId: 2,
    term: 'invoice',
    kind: 'missing_preferred',
    preferred: 'Rechnung',
    found: 'Faktura',
    ...over,
  });

  it('records only a row where another acceptable rendering was used', () => {
    expect(canRecordException(row({}))).toBe(true);
    expect(canRecordException(row({ found: null }))).toBe(false);
    expect(canRecordException(row({ kind: 'forbidden', found: 'Beleg' }))).toBe(false);
  });

  it('words a proposal as the evidence and the change', () => {
    const p = {
      termId: 2,
      lang: 'de',
      term: 'invoice',
      chosen: 'Faktura',
      preferred: 'Rechnung',
    };
    expect(proposalText({ ...p, segments: 3 })).toBe(
      '“Faktura” was recorded as the translation in 3 segments: make it preferred over “Rechnung”?',
    );
    expect(proposalText({ ...p, segments: 1 })).toContain('in 1 segment:');
  });
});
