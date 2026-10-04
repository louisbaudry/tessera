/** Start, deliver, and the payable locked at delivery (backlog #120; vendor-spec.md decision 10). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvalidAssignmentTransitionError } from '@cat-tool/vendor-core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import {
  acceptAssignment,
  addVendor,
  AssignmentAccessError,
  createDirectOffer,
  createVendorFile,
  deliverAssignment,
  getAssignment,
  getAssignmentPayable,
  setVendorRate,
  startAssignment,
} from './index.js';

const NOW = new Date('2026-03-01T10:00:00Z');
const PAIR = { src: 'en', tgt: 'de' };
const owner = { ...TEST_ACTOR, label: 'owner' };
const who = { ...TEST_ACTOR, label: 'vendor' };

let dir: string;
let db: Database;
let ana: number;
let ben: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-delivery-'));
  db = createVendorFile(join(dir, 'vendors.ctv'), { generator: 'test' });
  ana = addVendor(db, { accountId: 10, actor: TEST_ACTOR }).id;
  ben = addVendor(db, { accountId: 11, actor: TEST_ACTOR }).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const rate = (
  tier: 'no_match' | 'exact' | 'ice',
  rateMicros: number,
  currency = 'EUR',
  vendorId = ana,
) =>
  setVendorRate(db, {
    vendorId,
    pair: PAIR,
    tier,
    rateMicros,
    currency,
    effectiveFrom: '2026-03-01',
    actor: owner,
    now: NOW,
  });

/** An accepted job with a frozen analysis (or none), ready to start. */
function accepted(analysis?: Record<string, number>, vendorId = ana): number {
  const a = createDirectOffer(db, {
    projectName: 'p',
    vendorId,
    ...(analysis ? { analysis } : {}),
    actor: owner,
    now: NOW,
  });
  acceptAssignment(db, { assignmentId: a.id, vendorId, actor: who, now: NOW });
  return a.id;
}

const start = (id: number, vendorId = ana) =>
  startAssignment(db, { assignmentId: id, vendorId, actor: who, now: NOW });
const deliver = (id: number, pair: typeof PAIR | null = PAIR, vendorId = ana) =>
  deliverAssignment(db, { assignmentId: id, vendorId, pair, actor: who, now: NOW });

describe('start and deliver', () => {
  it('walk accepted → in_progress → delivered, as the vendor, and only in order', () => {
    const id = accepted();
    expect(() => deliver(id)).toThrow(InvalidAssignmentTransitionError); // not started
    expect(start(id).status).toBe('in_progress');
    expect(deliver(id).status).toBe('delivered');
    expect(() => start(id)).toThrow(InvalidAssignmentTransitionError);
  });

  it('are the assigned vendor’s alone', () => {
    const id = accepted();
    expect(() => start(id, ben)).toThrow(AssignmentAccessError);
    start(id);
    expect(() => deliver(id, PAIR, ben)).toThrow(AssignmentAccessError);
  });
});

describe('the payable locked at delivery', () => {
  it('is the frozen words at the offer date’s rates, as lines in tier order', () => {
    rate('no_match', 80_000);
    rate('exact', 8_000);
    const id = accepted({ exact: 50, no_match: 100 });
    start(id);
    deliver(id);
    expect(getAssignmentPayable(db, id)).toEqual({
      lockedAt: NOW.toISOString(),
      currency: 'EUR',
      words: 150,
      totalMicros: 100 * 80_000 + 50 * 8_000,
      complete: true,
      lines: [
        { tier: 'no_match', words: 100, rateMicros: 80_000, amountMicros: 8_000_000 },
        { tier: 'exact', words: 50, rateMicros: 8_000, amountMicros: 400_000 },
      ],
    });
  });

  it('is not moved by a rate written afterwards, and cannot be edited or deleted', () => {
    rate('no_match', 80_000);
    const id = accepted({ no_match: 10 });
    start(id);
    deliver(id);
    const before = getAssignmentPayable(db, id);
    setVendorRate(db, {
      vendorId: ana,
      pair: PAIR,
      tier: 'no_match',
      rateMicros: 999_000,
      currency: 'EUR',
      effectiveFrom: '2026-04-01',
      actor: owner,
      now: NOW,
    });
    expect(getAssignmentPayable(db, id)).toEqual(before);
    for (const sql of [
      'UPDATE assignment_payable SET total_micros = 1',
      'DELETE FROM assignment_payable',
      'UPDATE assignment_payable_line SET amount_micros = 1',
      'DELETE FROM assignment_payable_line',
    ]) {
      expect(() => db.prepare(sql).run(), sql).toThrow(/locked at delivery/);
    }
  });

  it('stores a tier with no rate as such, never as zero, and says it is not complete', () => {
    rate('no_match', 80_000);
    const id = accepted({ no_match: 10, ice: 5 });
    start(id);
    deliver(id);
    const p = getAssignmentPayable(db, id)!;
    expect(p.complete).toBe(false);
    expect(p.totalMicros).toBe(800_000);
    expect(p.lines.find((l) => l.tier === 'ice')).toEqual({
      tier: 'ice',
      words: 5,
      rateMicros: null,
      amountMicros: 0,
    });
  });

  it('is a locked zero for a project with no words, not nothing', () => {
    rate('no_match', 80_000);
    const id = accepted({});
    start(id);
    deliver(id);
    expect(getAssignmentPayable(db, id)).toMatchObject({
      words: 0,
      totalMicros: 0,
      complete: true,
      lines: [],
    });
  });

  it('is absent, and the job still delivered, when there is nothing to price', () => {
    rate('no_match', 80_000);
    const noAnalysis = accepted();
    start(noAnalysis);
    expect(deliver(noAnalysis).status).toBe('delivered');
    expect(getAssignmentPayable(db, noAnalysis)).toBeNull();

    const noPair = accepted({ no_match: 10 });
    start(noPair);
    expect(deliver(noPair, null).status).toBe('delivered');
    expect(getAssignmentPayable(db, noPair)).toBeNull();

    const unspaced = accepted({ no_match: 10 });
    start(unspaced);
    expect(deliver(unspaced, { src: 'ja', tgt: 'en' }).status).toBe('delivered');
    expect(getAssignmentPayable(db, unspaced)).toBeNull();
  });

  it('is absent, not an error, for a card in two currencies', () => {
    rate('no_match', 80_000, 'EUR');
    rate('exact', 8_000, 'USD');
    const id = accepted({ no_match: 1, exact: 1 });
    start(id);
    expect(deliver(id).status).toBe('delivered');
    expect(getAssignmentPayable(db, id)).toBeNull();
  });

  it('commits with the delivery or not at all: a failed lock leaves the job in progress', () => {
    rate('no_match', 80_000);
    const id = accepted({ no_match: 10 });
    start(id);
    // a row already there makes the lock's insert fail
    db.prepare(
      `INSERT INTO assignment_payable (assignment_id, currency, words, total_micros, complete, locked_at)
       VALUES (?, 'EUR', 0, 0, 1, 'x')`,
    ).run(id);
    expect(() => deliver(id)).toThrow();
    expect(getAssignment(db, id)!.status).toBe('in_progress');
  });
});
