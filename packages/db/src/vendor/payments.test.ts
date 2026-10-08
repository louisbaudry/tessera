/** Payments against locked payables, the ledger and the export record (backlog #112). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { verifyAudit } from '../audit/events.js';
import { openAndMigrate } from '../migrate.js';
import {
  acceptAssignment,
  addVendor,
  createDirectOffer,
  createVendorFile,
  deliverAssignment,
  listLedger,
  listPaymentEvents,
  getPaymentState,
  NoPayableError,
  PaymentConflictError,
  recordLedgerExport,
  recordPayment,
  reopenPayment,
  setVendorRate,
  startAssignment,
  VendorError,
  VENDOR_APPLICATION_ID,
  VENDOR_MIGRATIONS,
} from './index.js';

const LOCKED = new Date('2026-03-01T10:00:00Z');
const TODAY = new Date('2026-03-10T09:00:00Z');
const PAIR = { src: 'en', tgt: 'de' };
const owner = { ...TEST_ACTOR, label: 'owner' };
const who = { ...TEST_ACTOR, label: 'vendor' };

let dir: string;
let db: Database;
let ana: number;
let ben: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-payments-'));
  db = createVendorFile(join(dir, 'vendors.ctv'), { generator: 'test' });
  ana = addVendor(db, { accountId: 10, displayName: 'Ana', actor: TEST_ACTOR }).id;
  ben = addVendor(db, { accountId: 11, actor: TEST_ACTOR }).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const rate = (rateMicros: number, currency: string, vendorId: number) =>
  setVendorRate(db, {
    vendorId,
    pair: PAIR,
    tier: 'no_match',
    rateMicros,
    currency,
    effectiveFrom: '2026-03-01',
    actor: owner,
    now: LOCKED,
  });

/** A delivered job with a locked payable, delivered at `at`. */
function delivered(
  words: number,
  vendorId = ana,
  project = 'p',
  at: Date = LOCKED,
): number {
  const a = createDirectOffer(db, {
    projectName: project,
    vendorId,
    analysis: { no_match: words },
    actor: owner,
    now: at,
  });
  acceptAssignment(db, { assignmentId: a.id, vendorId, actor: who, now: at });
  startAssignment(db, { assignmentId: a.id, vendorId, actor: who, now: at });
  deliverAssignment(db, {
    assignmentId: a.id,
    vendorId,
    pair: PAIR,
    actor: who,
    now: at,
  });
  return a.id;
}

const pay = (id: number, paidOn = '2026-03-04', now = TODAY) =>
  recordPayment(db, { assignmentId: id, paidOn, actor: owner, now });

describe('recording a payment', () => {
  it('marks a locked payable paid on the stated day, with the days it took', () => {
    rate(100_000, 'EUR', ana);
    const id = delivered(100);
    expect(getPaymentState(db, id)).toEqual({
      assignmentId: id,
      status: 'unpaid',
      paidOn: null,
      daysToPay: null,
    });
    expect(pay(id, '2026-03-04')).toEqual({
      assignmentId: id,
      status: 'paid',
      paidOn: '2026-03-04',
      daysToPay: 3,
    });
    expect(getPaymentState(db, id)?.status).toBe('paid');
  });

  it('names who recorded it and keeps a clean note', () => {
    rate(100_000, 'EUR', ana);
    const id = delivered(10);
    recordPayment(db, {
      assignmentId: id,
      paidOn: '2026-03-04',
      note: '  bank transfer  ',
      actor: owner,
      now: TODAY,
    });
    const [e] = listPaymentEvents(db, id);
    expect(e).toMatchObject({
      kind: 'paid',
      paidOn: '2026-03-04',
      note: 'bank transfer',
      actorLabel: 'owner',
      at: TODAY.toISOString(),
    });
    expect(e!.actor).toMatch(/^/);
  });

  it('refuses a payable that is already paid, until it is reopened', () => {
    rate(100_000, 'EUR', ana);
    const id = delivered(10);
    pay(id);
    expect(() => pay(id, '2026-03-05')).toThrow(PaymentConflictError);
    reopenPayment(db, { assignmentId: id, actor: owner, now: TODAY });
    expect(pay(id, '2026-03-05').paidOn).toBe('2026-03-05');
  });

  it('refuses a date in the future and a date before the payable locked', () => {
    rate(100_000, 'EUR', ana);
    const id = delivered(10);
    expect(() => pay(id, '2026-03-11')).toThrow(/in the future/);
    expect(() => pay(id, '2026-02-28')).toThrow(/locked on 2026-03-01/);
    expect(pay(id, '2026-03-01').daysToPay).toBe(0);
    expect(getPaymentState(db, id)?.status).toBe('paid');
  });

  it('refuses what is not a date', () => {
    rate(100_000, 'EUR', ana);
    const id = delivered(10);
    for (const bad of [
      '',
      '2026-3-4',
      '2026-02-31',
      'yesterday',
      '2026-03-04T10:00:00Z',
    ]) {
      expect(() => pay(id, bad), bad).toThrow(VendorError);
    }
    expect(getPaymentState(db, id)?.status).toBe('unpaid');
  });

  it('refuses an assignment with no locked payable', () => {
    const a = createDirectOffer(db, { projectName: 'p', vendorId: ana, actor: owner });
    expect(() => pay(a.id)).toThrow(NoPayableError);
    expect(() => pay(9999)).toThrow(NoPayableError);
    expect(getPaymentState(db, a.id)).toBeNull();
  });

  it('refuses an over-long note and records nothing', () => {
    rate(100_000, 'EUR', ana);
    const id = delivered(10);
    expect(() =>
      recordPayment(db, {
        assignmentId: id,
        paidOn: '2026-03-04',
        note: 'x'.repeat(2001),
        actor: owner,
        now: TODAY,
      }),
    ).toThrow(/at most 2000/);
    expect(listPaymentEvents(db, id)).toEqual([]);
  });
});

describe('reopening a payment', () => {
  it('only reopens a paid payable, and the log keeps both events', () => {
    rate(100_000, 'EUR', ana);
    const id = delivered(10);
    expect(() => reopenPayment(db, { assignmentId: id, actor: owner })).toThrow(
      PaymentConflictError,
    );
    pay(id, '2026-03-04');
    const after = reopenPayment(db, {
      assignmentId: id,
      note: 'wrong day',
      actor: owner,
      now: TODAY,
    });
    expect(after).toMatchObject({ status: 'unpaid', paidOn: null, daysToPay: null });
    expect(() => reopenPayment(db, { assignmentId: id, actor: owner })).toThrow(
      PaymentConflictError,
    );
    expect(listPaymentEvents(db, id).map((e) => [e.kind, e.paidOn, e.note])).toEqual([
      ['paid', '2026-03-04', null],
      ['reopened', null, 'wrong day'],
    ]);
  });

  it('refuses an assignment with no payable', () => {
    expect(() => reopenPayment(db, { assignmentId: 7, actor: owner })).toThrow(
      NoPayableError,
    );
  });
});

describe('the event log', () => {
  it('cannot be edited or deleted, except to erase a person’s label', () => {
    rate(100_000, 'EUR', ana);
    const id = delivered(10);
    pay(id);
    for (const sql of [
      "UPDATE assignment_payment_event SET paid_on = '2026-03-02'",
      "UPDATE assignment_payment_event SET note = 'x'",
      'DELETE FROM assignment_payment_event',
    ]) {
      expect(() => db.prepare(sql).run(), sql).toThrow(/append-only/);
    }
    db.prepare("UPDATE assignment_payment_event SET actor_label = '[erased]'").run();
    expect(listPaymentEvents(db, id)[0]!.actorLabel).toBe('[erased]');
  });

  it('refuses a paid event with no date and a reopened one with a date', () => {
    rate(100_000, 'EUR', ana);
    const id = delivered(10);
    const insert = (kind: string, paidOn: string | null) =>
      db
        .prepare(
          `INSERT INTO assignment_payment_event
             (assignment_id, kind, paid_on, actor, at) VALUES (?, ?, ?, 'a', 'n')`,
        )
        .run(id, kind, paidOn);
    expect(() => insert('paid', null)).toThrow(/CHECK/);
    expect(() => insert('reopened', '2026-03-04')).toThrow(/CHECK/);
    expect(() => insert('settled', '2026-03-04')).toThrow(/CHECK/);
  });
});

describe('the ledger', () => {
  it('lists every locked payable, newest first, with its state and flags', () => {
    rate(100_000, 'EUR', ana);
    rate(200_000, 'USD', ben);
    const a = delivered(100, ana, 'alpha', new Date('2026-03-01T10:00:00Z'));
    const b = delivered(50, ben, 'beta', new Date('2026-03-05T10:00:00Z'));
    pay(a, '2026-03-04');
    const rows = listLedger(db);
    expect(rows.map((r) => r.assignmentId)).toEqual([b, a]);
    expect(rows[1]).toMatchObject({
      project: 'alpha',
      vendorId: ana,
      vendorAccountId: 10,
      vendorLabel: 'Ana',
      currency: 'EUR',
      words: 100,
      totalMicros: 10_000_000,
      complete: true,
      status: 'paid',
      paidOn: '2026-03-04',
    });
    expect(rows[0]).toMatchObject({
      vendorLabel: 'account 11',
      currency: 'USD',
      totalMicros: 10_000_000,
      status: 'unpaid',
      paidOn: null,
    });
  });

  it('filters by vendor, by status and by the day the payable locked, inclusive', () => {
    rate(100_000, 'EUR', ana);
    rate(100_000, 'EUR', ben);
    const a = delivered(10, ana, 'a', new Date('2026-03-01T23:59:00Z'));
    const b = delivered(10, ben, 'b', new Date('2026-03-02T00:00:00Z'));
    const c = delivered(10, ana, 'c', new Date('2026-03-03T10:00:00Z'));
    pay(b, '2026-03-04');
    const ids = (f: Parameters<typeof listLedger>[1]) =>
      listLedger(db, f)
        .map((r) => r.assignmentId)
        .sort((x, y) => x - y);
    expect(ids({ vendorId: ana })).toEqual([a, c]);
    expect(ids({ status: 'paid' })).toEqual([b]);
    expect(ids({ status: 'unpaid' })).toEqual([a, c]);
    expect(ids({ from: '2026-03-02', to: '2026-03-02' })).toEqual([b]);
    expect(ids({ from: '2026-03-02' })).toEqual([b, c]);
    expect(ids({ to: '2026-03-01' })).toEqual([a]);
    expect(ids({ from: '2026-04-01' })).toEqual([]);
  });

  it('shows a payable with an unpriced tier as incomplete, and one with no currency as owing nothing', () => {
    // Two tiers with words, one rate: the exact tier is left out of the total.
    rate(100_000, 'EUR', ana);
    const a = createDirectOffer(db, {
      projectName: 'p',
      vendorId: ana,
      analysis: { no_match: 10, exact: 5 },
      actor: owner,
      now: LOCKED,
    });
    acceptAssignment(db, { assignmentId: a.id, vendorId: ana, actor: who, now: LOCKED });
    startAssignment(db, { assignmentId: a.id, vendorId: ana, actor: who, now: LOCKED });
    deliverAssignment(db, {
      assignmentId: a.id,
      vendorId: ana,
      pair: PAIR,
      actor: who,
      now: LOCKED,
    });
    // A vendor with no rates at all: nothing priced, so no currency.
    const none = delivered(10, ben, 'q');
    const rows = listLedger(db);
    expect(rows.find((r) => r.assignmentId === a.id)).toMatchObject({
      complete: false,
      currency: 'EUR',
      totalMicros: 1_000_000,
    });
    expect(rows.find((r) => r.assignmentId === none)).toMatchObject({
      complete: false,
      currency: null,
      totalMicros: 0,
    });
  });

  it('refuses a bad period', () => {
    expect(() => listLedger(db, { from: '2026-3-1' })).toThrow(VendorError);
    expect(() => listLedger(db, { to: 'soon' })).toThrow(VendorError);
    expect(() => listLedger(db, { from: '2026-03-05', to: '2026-03-01' })).toThrow(
      /after/,
    );
  });

  it('is empty on a fresh roster', () => {
    expect(listLedger(db)).toEqual([]);
  });
});

describe('recording an export', () => {
  it('writes payables.exported with a count and a digest, in the log’s chain', () => {
    recordLedgerExport(db, { rows: 3, sha256: 'ab'.repeat(32), actor: owner });
    const last = db
      .prepare('SELECT * FROM audit_event ORDER BY id DESC LIMIT 1')
      .get() as Record<string, string | null>;
    expect(last).toMatchObject({
      action: 'payables.exported',
      subject_type: 'payables',
      subject_id: null,
      actor_label: 'owner',
    });
    expect(JSON.parse(last.detail ?? 'null')).toEqual({
      rows: 3,
      sha256: 'ab'.repeat(32),
    });
    expect(verifyAudit(db).brokenAt).toBeNull();
  });
});

describe('the v5 migration', () => {
  it('keeps the audit chain and its rows when it widens the action list', () => {
    const path = join(dir, 'old.ctv');
    const old = openAndMigrate(path, {
      applicationId: VENDOR_APPLICATION_ID,
      migrations: VENDOR_MIGRATIONS.slice(0, 4),
    });
    addVendor(old, { accountId: 1, actor: TEST_ACTOR });
    addVendor(old, { accountId: 2, actor: TEST_ACTOR });
    const events = (d: Database) =>
      d
        .prepare('SELECT id, action, chain_hash FROM audit_event ORDER BY id')
        .all() as Array<{ id: number; action: string; chain_hash: string }>;
    const before = events(old);
    expect(before).toHaveLength(2);
    expect(() => recordLedgerExport(old, { rows: 0, sha256: 'x', actor: owner })).toThrow(
      /CHECK/,
    );
    old.close();

    const upgraded = openAndMigrate(path, {
      applicationId: VENDOR_APPLICATION_ID,
      migrations: VENDOR_MIGRATIONS,
    });
    try {
      expect(events(upgraded)).toEqual(before);
      recordLedgerExport(upgraded, { rows: 0, sha256: 'x', actor: owner });
      expect(verifyAudit(upgraded)).toMatchObject({ events: 3, brokenAt: null });
      expect(
        upgraded
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'assignment_payment_event'",
          )
          .all(),
      ).toHaveLength(1);
    } finally {
      upgraded.close();
    }
  });
});
