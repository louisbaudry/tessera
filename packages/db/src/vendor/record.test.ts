/** A vendor's record read off the roster (vendor-spec.md, the #123 note). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AssignmentStatus } from '@cat-tool/vendor-core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import {
  addVendor,
  createDirectOffer,
  createVendorFile,
  moveAssignment,
  postToPool,
  vendorRecords,
} from './index.js';

const owner = { ...TEST_ACTOR, label: 'owner' };
const vendorActor = { ...TEST_ACTOR, label: 'vendor' };

let dir: string;
let roster: Database;
let ana: number;
let ben: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-record-'));
  roster = createVendorFile(join(dir, 'vendors.ctv'), { generator: 'test' });
  ana = addVendor(roster, { accountId: 10, actor: TEST_ACTOR }).id;
  ben = addVendor(roster, { accountId: 11, actor: TEST_ACTOR }).id;
});
afterEach(() => {
  roster.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** An offer to `vendorId`, taken through `path` (each step at its own instant). */
function offer(
  vendorId: number,
  path: readonly AssignmentStatus[],
  options: { deadline?: string; deliveredAt?: string } = {},
): number {
  const a = createDirectOffer(roster, {
    projectName: 'p',
    vendorId,
    deadline: options.deadline ?? null,
    actor: owner,
    now: new Date('2026-03-01T10:00:00Z'),
  });
  for (const to of path) {
    moveAssignment(roster, {
      assignmentId: a.id,
      vendorId,
      to,
      by: 'vendor',
      actor: vendorActor,
      now: new Date(
        to === 'delivered' && options.deliveredAt
          ? options.deliveredAt
          : '2026-03-02T10:00:00Z',
      ),
    });
  }
  return a.id;
}

describe('vendorRecords', () => {
  it('has no entry for a vendor who holds no assignment', () => {
    expect(vendorRecords(roster).size).toBe(0);
  });

  it('counts each vendor from their own assignments only', () => {
    offer(ana, ['accepted']);
    offer(ana, ['declined']);
    offer(ben, ['accepted']);
    const records = vendorRecords(roster);
    expect(records.get(ana)).toMatchObject({ answered: 2, accepted: 1 });
    expect(records.get(ben)).toMatchObject({ answered: 1, accepted: 1 });
  });

  it('leaves an unanswered offer out of the sample: silence is not a no', () => {
    offer(ana, []);
    expect(vendorRecords(roster).get(ana)).toMatchObject({ answered: 0, accepted: 0 });
  });

  it('reads on time from the delivered event, not from when the job was last touched', () => {
    offer(ana, ['accepted', 'in_progress', 'delivered'], {
      deadline: '2026-03-10T12:00:00Z',
      deliveredAt: '2026-03-09T09:00:00Z',
    });
    offer(ana, ['accepted', 'in_progress', 'delivered'], {
      deadline: '2026-03-10T12:00:00Z',
      deliveredAt: '2026-03-11T09:00:00Z',
    });
    expect(vendorRecords(roster).get(ana)).toMatchObject({
      delivered: 2,
      timed: 2,
      onTime: 1,
    });
  });

  it('does not credit a pool job to a vendor who did not claim it', () => {
    postToPool(roster, {
      projectName: 'p',
      vendorIds: [ana, ben],
      actor: owner,
      now: new Date('2026-03-01T10:00:00Z'),
    });
    expect(vendorRecords(roster).size).toBe(0);
  });
});
