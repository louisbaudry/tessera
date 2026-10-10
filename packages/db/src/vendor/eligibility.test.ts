/** The roster read against a job (vendor-spec.md, the #156 note). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import {
  addVendor,
  assessRoster,
  createVendorFile,
  listAssignmentsFor,
  setCapacity,
  updateProfile,
} from './index.js';

let dir: string;
let roster: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-eligibility-'));
  roster = createVendorFile(join(dir, 'vendors.ctv'), { generator: 'test' });
});
afterEach(() => {
  roster.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (accountId: number, over: Partial<Parameters<typeof addVendor>[1]> = {}) =>
  addVendor(roster, {
    accountId,
    languages: [{ src: 'en', tgt: 'de' }],
    specialties: ['legal'],
    actor: TEST_ACTOR,
    ...over,
  });

describe('assessRoster', () => {
  it('lists every vendor, in roster order, with the reasons they do not fit', () => {
    const fit = add(1);
    const wrongPair = add(2, { languages: [{ src: 'en', tgt: 'fr' }] });
    const busy = add(3);
    setCapacity(roster, { vendorId: busy.id, status: 'busy' });
    const away = add(4, { specialties: [] });
    setCapacity(roster, { vendorId: away.id, status: 'away' });

    const fits = assessRoster(roster, { src: 'en-GB', tgt: 'de', specialty: 'Legal' });
    expect(fits.map((f) => [f.accountId, f.reasons])).toEqual([
      [1, []],
      [2, ['language_pair']],
      [3, ['busy']],
      [4, ['specialty', 'away']],
    ]);
    expect(fits.map((f) => f.vendorId)).toEqual([fit.id, wrongPair.id, busy.id, away.id]);
  });

  it('reads capacity as it is now, and a vendor who never set one fits', () => {
    const v = add(1);
    expect(assessRoster(roster, { src: 'en', tgt: 'de' })[0]!.reasons).toEqual([]);
    setCapacity(roster, { vendorId: v.id, status: 'away' });
    expect(assessRoster(roster, { src: 'en', tgt: 'de' })[0]!.reasons).toEqual(['away']);
    setCapacity(roster, { vendorId: v.id, status: 'available' });
    expect(assessRoster(roster, { src: 'en', tgt: 'de' })[0]!.reasons).toEqual([]);
  });

  it('follows a profile edit', () => {
    const v = add(1);
    updateProfile(roster, { vendorId: v.id, languages: [], actor: TEST_ACTOR });
    expect(assessRoster(roster, { src: 'en', tgt: 'de' })[0]!.reasons).toEqual([
      'language_pair',
    ]);
  });

  it('writes nothing: it is a read, with no event and no assignment', () => {
    add(1);
    const before = (
      roster.prepare('SELECT COUNT(*) AS n FROM audit_event').get() as { n: number }
    ).n;
    assessRoster(roster, { src: 'en', tgt: 'de' });
    expect(
      (roster.prepare('SELECT COUNT(*) AS n FROM audit_event').get() as { n: number }).n,
    ).toBe(before);
    expect(listAssignmentsFor(roster, 1)).toEqual([]);
  });
});
