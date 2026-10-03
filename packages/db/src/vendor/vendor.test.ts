/**
 * The `.ctv` roster file (backlog #46; vendor-spec.md §5 and its #46 note):
 * identity and migration, the roster, the append-only rate card with the
 * card's "done when" (a newer entry never changes what an earlier date
 * paid), capacity, and the audit events with no personal text in them.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import SqliteDatabase, { type Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import {
  addVendor,
  createVendorFile,
  getCapacity,
  getProfile,
  getVendorByAccount,
  listVendors,
  openVendorFile,
  setCapacity,
  setVendorRate,
  updateProfile,
  VENDOR_APPLICATION_ID,
  VendorError,
  vendorRateAt,
  vendorRateCardAt,
  vendorRateHistory,
} from './index.js';

let dir: string;
let db: Database;
const T0 = new Date('2026-03-01T10:00:00Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-vendor-'));
  db = createVendorFile(join(dir, 'vendors.ctv'), { generator: 'test' });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const vendor = (accountId = 7) =>
  addVendor(db, { accountId, displayName: 'Ana Vendor', actor: TEST_ACTOR });

const rate = (
  vendorId: number,
  over: Partial<Parameters<typeof setVendorRate>[1]> = {},
) =>
  setVendorRate(db, {
    vendorId,
    pair: { src: 'en', tgt: 'de' },
    tier: 'no_match',
    rateMicros: 80_000,
    currency: 'EUR',
    effectiveFrom: '2026-03-01',
    actor: TEST_ACTOR,
    now: T0,
    ...over,
  });

const events = (vendorId: number) =>
  listEvents(db, { subjectType: 'vendor', subjectId: String(vendorId) });

describe('the file', () => {
  it('is its own kind of file, with an identity row and the current format version', () => {
    expect(db.pragma('application_id', { simple: true })).toBe(VENDOR_APPLICATION_ID);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    const id = db.prepare('SELECT * FROM vendor_file').get() as { generator: string };
    expect(id.generator).toBe('test');
  });

  it('is created once, and reopens with its roster intact', () => {
    vendor();
    db.close();
    expect(() => createVendorFile(join(dir, 'vendors.ctv'), { generator: 'x' })).toThrow(
      /already an initialised/,
    );
    db = openVendorFile(join(dir, 'vendors.ctv'));
    expect(listVendors(db)).toHaveLength(1);
  });

  it('refuses a file that is not one of ours', () => {
    const foreign = join(dir, 'foreign.ctv');
    const other = new SqliteDatabase(foreign);
    other.pragma('application_id = 1112754007'); // a .ctm's
    other.close();
    expect(() => openVendorFile(foreign)).toThrow(/not one of ours/);
  });
});

describe('the roster', () => {
  it('adds an account once, keyed by it, with languages and specialties normalised', () => {
    const v = addVendor(db, {
      accountId: 9,
      displayName: '  Ana  ',
      languages: [
        { src: 'en-GB', tgt: 'de-AT' },
        { src: 'EN', tgt: 'de' },
        { src: 'es', tgt: 'en' },
      ],
      specialties: [' Legal ', 'legal', 'Medical   Devices', '  '],
      actor: TEST_ACTOR,
    });
    expect(v.displayName).toBe('Ana');
    expect(getVendorByAccount(db, 9)?.id).toBe(v.id);
    const profile = getProfile(db, v.id)!;
    expect(profile.languages).toEqual([
      { src: 'en', tgt: 'de' },
      { src: 'es', tgt: 'en' },
    ]);
    expect(profile.specialties).toEqual(['legal', 'medical devices']);
    expect(() => addVendor(db, { accountId: 9, actor: TEST_ACTOR })).toThrow(
      /already on the roster/,
    );
  });

  it('refuses nonsense: a bad account, a pair of one language, a missing language', () => {
    expect(() => addVendor(db, { accountId: 0, actor: TEST_ACTOR })).toThrow(VendorError);
    expect(() =>
      addVendor(db, {
        accountId: 1,
        languages: [{ src: 'en', tgt: 'en-GB' }],
        actor: TEST_ACTOR,
      }),
    ).toThrow(/not a language pair/);
    expect(() =>
      addVendor(db, {
        accountId: 1,
        languages: [{ src: '', tgt: 'de' }],
        actor: TEST_ACTOR,
      }),
    ).toThrow(/both languages/);
    expect(listVendors(db)).toEqual([]);
  });

  it('records one event for each add, and none carries the name', () => {
    const v = vendor();
    const [added] = events(v.id);
    expect(added).toMatchObject({
      action: 'vendor.added',
      actor: 'cli:test',
      detail: null,
    });
    expect(verifyAudit(db).brokenAt).toBeNull();
  });

  it('updates the parts it is given, and the event names which changed, never to what', () => {
    const v = vendor();
    updateProfile(db, {
      vendorId: v.id,
      displayName: 'Ana Maria Secret-Surname',
      languages: [{ src: 'en', tgt: 'de' }],
      actor: TEST_ACTOR,
    });
    const changed = events(v.id).filter((e) => e.action === 'vendor.profile_changed');
    expect(changed).toHaveLength(1);
    expect(JSON.parse(changed[0]!.detail!)).toEqual({
      changed: ['display_name', 'languages'],
    });
    expect(changed[0]!.detail).not.toContain('Secret');
  });

  it('writes nothing, not even an event, when nothing changed', () => {
    const v = vendor();
    updateProfile(db, {
      vendorId: v.id,
      displayName: 'Ana Vendor',
      languages: [],
      specialties: [],
      actor: TEST_ACTOR,
    });
    expect(events(v.id).map((e) => e.action)).toEqual(['vendor.added']);
  });

  it('replaces a set rather than adding to it, and clears a name with null', () => {
    const v = addVendor(db, {
      accountId: 3,
      displayName: 'Ana',
      specialties: ['legal', 'medical'],
      actor: TEST_ACTOR,
    });
    const after = updateProfile(db, {
      vendorId: v.id,
      displayName: null,
      specialties: ['legal'],
      actor: TEST_ACTOR,
    });
    expect(after.displayName).toBeNull();
    expect(after.specialties).toEqual(['legal']);
  });

  it('refuses an unknown vendor', () => {
    expect(() => updateProfile(db, { vendorId: 99, actor: TEST_ACTOR })).toThrow(
      /no vendor #99/,
    );
  });
});

describe('the rate card', () => {
  it('done when: a newer entry never changes what an earlier date paid', () => {
    const v = vendor();
    const first = rate(v.id, { rateMicros: 80_000, effectiveFrom: '2026-03-01' });
    // the job was delivered on 1 April, paid at the rate in force then
    const paidAtDelivery = vendorRateAt(db, keyOf(v.id), '2026-04-01T09:30:00Z');
    expect(paidAtDelivery?.rateMicros).toBe(80_000);

    // a rise is entered later, effective in June
    rate(v.id, {
      rateMicros: 95_000,
      effectiveFrom: '2026-06-01',
      now: new Date('2026-05-20T00:00:00Z'),
    });

    expect(vendorRateAt(db, keyOf(v.id), '2026-04-01T09:30:00Z')).toEqual(paidAtDelivery);
    expect(vendorRateAt(db, keyOf(v.id), '2026-04-01')?.id).toBe(first.id);
    expect(vendorRateAt(db, keyOf(v.id), '2026-06-01')?.rateMicros).toBe(95_000);
    expect(vendorRateAt(db, keyOf(v.id), '2026-05-31')?.rateMicros).toBe(80_000);
  });

  it('has no rate before the first entry took effect', () => {
    const v = vendor();
    rate(v.id, { effectiveFrom: '2026-03-01' });
    expect(vendorRateAt(db, keyOf(v.id), '2026-02-28')).toBeNull();
  });

  it('keys a rate by vendor, pair and tier, pairing by primary subtag', () => {
    const a = vendor(1);
    const b = vendor(2);
    rate(a.id, { rateMicros: 80_000 });
    rate(a.id, { tier: 'exact', rateMicros: 20_000 });
    rate(b.id, { rateMicros: 70_000 });
    expect(vendorRateAt(db, keyOf(a.id), '2026-03-01')?.rateMicros).toBe(80_000);
    expect(vendorRateAt(db, keyOf(b.id), '2026-03-01')?.rateMicros).toBe(70_000);
    expect(
      vendorRateAt(db, { ...keyOf(a.id), tier: 'exact' }, '2026-03-01')?.rateMicros,
    ).toBe(20_000);
    expect(
      vendorRateAt(
        db,
        { ...keyOf(a.id), pair: { src: 'en-US', tgt: 'de-CH' } },
        '2026-03-01',
      )?.rateMicros,
    ).toBe(80_000);
    expect(
      vendorRateAt(db, { ...keyOf(a.id), pair: { src: 'de', tgt: 'en' } }, '2026-03-01'),
    ).toBeNull();
  });

  it('refuses a date in the past, so a new row cannot rewrite a period already paid', () => {
    const v = vendor();
    expect(() => rate(v.id, { effectiveFrom: '2026-02-28' })).toThrow(/in the past/);
    expect(vendorRateHistory(db, v.id)).toEqual([]);
  });

  it('refuses a date before the newest entry for the same key, but not for another key', () => {
    const v = vendor();
    rate(v.id, { effectiveFrom: '2026-06-01' });
    expect(() => rate(v.id, { effectiveFrom: '2026-05-01' })).toThrow(
      /rewrite the history/,
    );
    expect(() => rate(v.id, { tier: 'ice', effectiveFrom: '2026-05-01' })).not.toThrow();
  });

  it('lets a same-day correction win, as the later-written entry', () => {
    const v = vendor();
    rate(v.id, { rateMicros: 80_000, effectiveFrom: '2026-03-01' });
    rate(v.id, { rateMicros: 85_000, effectiveFrom: '2026-03-01' });
    expect(vendorRateAt(db, keyOf(v.id), '2026-03-01')?.rateMicros).toBe(85_000);
    expect(vendorRateHistory(db, v.id).map((r) => r.rateMicros)).toEqual([
      80_000, 85_000,
    ]);
  });

  it('refuses a bad tier, rate, currency, date or vendor', () => {
    const v = vendor();
    expect(() => rate(v.id, { tier: 'fuzzy' as never })).toThrow(/unknown rate tier/);
    expect(() => rate(v.id, { rateMicros: -1 })).toThrow(/non-negative integer/);
    expect(() => rate(v.id, { rateMicros: 0.5 })).toThrow(/non-negative integer/);
    expect(() => rate(v.id, { currency: 'EURO' })).toThrow(/currency/);
    expect(() => rate(v.id, { effectiveFrom: '2026-02-31' })).toThrow(/not a date/);
    expect(() => rate(v.id, { effectiveFrom: '1 March' })).toThrow(/not a date/);
    expect(() => rate(999)).toThrow(/no vendor #999/);
    expect(vendorRateHistory(db, v.id)).toEqual([]);
  });

  it('is append-only, by trigger: no update and no delete, whoever holds the connection', () => {
    const v = vendor();
    rate(v.id);
    expect(() => db.prepare('UPDATE rate_card_entry SET rate_micros = 1').run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM rate_card_entry').run()).toThrow(/append-only/);
  });

  it('records a price, not a person: pair, tier, rate, currency and date, in the chain', () => {
    const v = vendor();
    rate(v.id, { currency: 'eur' });
    const set = events(v.id).find((e) => e.action === 'vendor.rate_set')!;
    expect(JSON.parse(set.detail!)).toEqual({
      src_lang: 'en',
      tgt_lang: 'de',
      tier: 'no_match',
      rate_micros: 80_000,
      currency: 'EUR',
      effective_from: '2026-03-01',
    });
    expect(verifyAudit(db).brokenAt).toBeNull();
  });

  it('shows the whole card as it stood on a date: one entry per pair and tier', () => {
    const v = vendor();
    rate(v.id, { rateMicros: 80_000, effectiveFrom: '2026-03-01' });
    rate(v.id, { tier: 'exact', rateMicros: 20_000, effectiveFrom: '2026-03-01' });
    rate(v.id, { rateMicros: 95_000, effectiveFrom: '2026-06-01' });
    expect(
      vendorRateCardAt(db, v.id, '2026-04-01').map((r) => [r.tier, r.rateMicros]),
    ).toEqual([
      ['no_match', 80_000],
      ['exact', 20_000],
    ]);
    expect(
      vendorRateCardAt(db, v.id, '2026-07-01').map((r) => [r.tier, r.rateMicros]),
    ).toEqual([
      ['exact', 20_000],
      ['no_match', 95_000],
    ]);
    expect(vendorRateCardAt(db, v.id, '2026-01-01')).toEqual([]);
  });
});

describe('capacity', () => {
  it('is one current row per vendor, replaced on each set, and none before the first', () => {
    const v = vendor();
    expect(getCapacity(db, v.id)).toBeNull();
    setCapacity(db, {
      vendorId: v.id,
      status: 'busy',
      note: ' until Friday ',
      setBy: 7,
      now: T0,
    });
    setCapacity(db, {
      vendorId: v.id,
      status: 'available',
      setBy: 7,
      now: new Date('2026-03-02T00:00:00Z'),
    });
    expect(getCapacity(db, v.id)).toEqual({
      vendorId: v.id,
      status: 'available',
      note: null,
      setAt: '2026-03-02T00:00:00.000Z',
      setBy: 7,
    });
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM capacity').get() as { n: number }).n,
    ).toBe(1);
  });

  it('keeps the note when given, trimmed, and writes no audit event', () => {
    const v = vendor();
    const c = setCapacity(db, { vendorId: v.id, status: 'away', note: ' on leave ' });
    expect(c.note).toBe('on leave');
    expect(events(v.id).map((e) => e.action)).toEqual(['vendor.added']);
  });

  it('refuses a status outside the set, a long note and an unknown vendor', () => {
    const v = vendor();
    expect(() => setCapacity(db, { vendorId: v.id, status: 'offline' as never })).toThrow(
      /unknown capacity status/,
    );
    expect(() =>
      setCapacity(db, { vendorId: v.id, status: 'busy', note: 'x'.repeat(501) }),
    ).toThrow(/at most 500/);
    expect(() => setCapacity(db, { vendorId: 99, status: 'busy' })).toThrow(
      /no vendor #99/,
    );
  });
});

function keyOf(vendorId: number) {
  return { vendorId, pair: { src: 'en', tgt: 'de' }, tier: 'no_match' as const };
}
