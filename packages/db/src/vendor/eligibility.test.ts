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
  getTimeOff,
  setCapacity,
  setTimeOff,
  updateProfile,
} from './index.js';
import { VendorError } from './error.js';

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

describe('time off (issue #156)', () => {
  const job = (from: string, to: string) => ({
    src: 'en',
    tgt: 'de',
    window: { from, to },
  });

  it('names a vendor whose time off meets the job’s days, and no one else', () => {
    const off = add(1);
    const on = add(2);
    setTimeOff(roster, off.id, [{ from: '2026-12-05', to: '2026-12-09' }]);
    setTimeOff(roster, on.id, [{ from: '2027-01-05', to: '2027-01-09' }]);
    expect(
      assessRoster(roster, job('2026-12-01', '2026-12-06')).map((f) => [
        f.accountId,
        f.reasons,
      ]),
    ).toEqual([
      [1, ['time_off']],
      [2, []],
    ]);
    // Without the job's days there is nothing to compare: no reason.
    expect(assessRoster(roster, { src: 'en', tgt: 'de' }).map((f) => f.reasons)).toEqual([
      [],
      [],
    ]);
  });

  it('replaces the list whole, keeps it in date order, and lists what is still to come', () => {
    const v = add(1);
    setTimeOff(roster, v.id, [
      { from: '2026-12-20', to: '2026-12-31' },
      { from: '2026-11-01', to: '2026-11-02' },
    ]);
    expect(getTimeOff(roster, v.id)).toEqual([
      { from: '2026-11-01', to: '2026-11-02' },
      { from: '2026-12-20', to: '2026-12-31' },
    ]);
    expect(getTimeOff(roster, v.id, { endingFrom: '2026-11-15' })).toEqual([
      { from: '2026-12-20', to: '2026-12-31' },
    ]);
    setTimeOff(roster, v.id, []);
    expect(getTimeOff(roster, v.id)).toEqual([]);
  });

  it('refuses a backwards or unreal window, and an unknown vendor, storing nothing', () => {
    const v = add(1);
    setTimeOff(roster, v.id, [{ from: '2026-12-01', to: '2026-12-02' }]);
    expect(() =>
      setTimeOff(roster, v.id, [{ from: '2026-12-10', to: '2026-12-01' }]),
    ).toThrow(VendorError);
    expect(() =>
      setTimeOff(roster, v.id, [{ from: '2026-02-30', to: '2026-03-01' }]),
    ).toThrow(VendorError);
    expect(() => setTimeOff(roster, 999, [])).toThrow(/no vendor/);
    expect(getTimeOff(roster, v.id)).toEqual([{ from: '2026-12-01', to: '2026-12-02' }]);
    // The schema holds the order too, whatever the caller.
    expect(() =>
      roster
        .prepare("INSERT INTO time_off VALUES (?, '2026-12-10', '2026-12-01')")
        .run(v.id),
    ).toThrow(/CHECK/);
  });
});
