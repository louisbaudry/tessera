/** A vendor's job feed (backlog #50; vendor-spec.md §7): four groups over `assignment`, nothing else. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import {
  acceptAssignment,
  addVendor,
  claimAssignment,
  createDirectOffer,
  createVendorFile,
  declineAssignment,
  DELIVERED_LIMIT,
  moveAssignment,
  postToPool,
  vendorFeed,
} from './index.js';

let dir: string;
let db: Database;
let ana: number;
let ben: number;
const NOW = new Date('2026-03-01T10:00:00Z');
const owner = { ...TEST_ACTOR, label: 'owner' };
const who = { ...TEST_ACTOR, label: 'vendor' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-feed-'));
  db = createVendorFile(join(dir, 'vendors.ctv'), { generator: 'test' });
  ana = addVendor(db, { accountId: 10, actor: TEST_ACTOR }).id;
  ben = addVendor(db, { accountId: 11, actor: TEST_ACTOR }).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const offer = (vendorId: number) =>
  createDirectOffer(db, { projectName: 'p', vendorId, actor: owner, now: NOW });
const ids = (list: Array<{ id: number }>) => list.map((a) => a.id);

describe('vendorFeed', () => {
  it('is four empty groups for a vendor with nothing', () => {
    expect(vendorFeed(db, ana)).toEqual({
      needsResponse: [],
      claimable: [],
      active: [],
      delivered: [],
    });
  });

  it('puts an offer needing an answer first, then moves it as it is answered', () => {
    const a = offer(ana);
    expect(ids(vendorFeed(db, ana).needsResponse)).toEqual([a.id]);
    acceptAssignment(db, { assignmentId: a.id, vendorId: ana, actor: who, now: NOW });
    const after = vendorFeed(db, ana);
    expect(ids(after.needsResponse)).toEqual([]);
    expect(ids(after.active)).toEqual([a.id]);
  });

  it('shows a pool job as claimable to a member only, and a claimed one as needing a response', () => {
    const p = postToPool(db, {
      projectName: 'p',
      vendorIds: [ana, ben],
      actor: owner,
      now: NOW,
    });
    expect(ids(vendorFeed(db, ana).claimable)).toEqual([p.id]);
    expect(ids(vendorFeed(db, ben).claimable)).toEqual([p.id]);
    claimAssignment(db, { assignmentId: p.id, vendorId: ana, actor: who, now: NOW });
    expect(ids(vendorFeed(db, ana).needsResponse)).toEqual([p.id]);
    expect(vendorFeed(db, ben).claimable).toEqual([]);
  });

  it('leaves a declined job out of every group', () => {
    const a = offer(ana);
    declineAssignment(db, { assignmentId: a.id, vendorId: ana, actor: who, now: NOW });
    const feed = vendorFeed(db, ana);
    expect([
      ...feed.needsResponse,
      ...feed.claimable,
      ...feed.active,
      ...feed.delivered,
    ]).toEqual([]);
  });

  it('keeps the latest delivered, newest first, and no more than the limit', () => {
    const made: number[] = [];
    for (let i = 0; i < DELIVERED_LIMIT + 2; i++) {
      const a = offer(ana);
      for (const to of ['accepted', 'in_progress', 'delivered'] as const) {
        moveAssignment(db, {
          assignmentId: a.id,
          vendorId: ana,
          to,
          by: 'vendor',
          actor: who,
          now: NOW,
        });
      }
      made.push(a.id);
    }
    const delivered = ids(vendorFeed(db, ana).delivered);
    expect(delivered).toHaveLength(DELIVERED_LIMIT);
    expect(delivered[0]).toBe(made[made.length - 1]);
  });

  it("never shows another vendor's jobs", () => {
    const a = offer(ben);
    expect(ids(vendorFeed(db, ana).needsResponse)).toEqual([]);
    expect(ids(vendorFeed(db, ben).needsResponse)).toEqual([a.id]);
  });
});
