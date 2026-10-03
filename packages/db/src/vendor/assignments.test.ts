/**
 * Assignments in the `.ctv` (backlog #48; vendor-spec.md §4 and its #48
 * note): offers, the pool, the one function that moves them, the claim
 * that two vendors cannot both win, the repost after a declined claim, and
 * the append-only log.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AssignmentPartyError,
  InvalidAssignmentTransitionError,
} from '@cat-tool/vendor-core';
import SqliteDatabase, { type Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { openAndMigrate } from '../migrate.js';
import {
  AssignmentAccessError,
  acceptAssignment,
  addVendor,
  claimAssignment,
  createDirectOffer,
  createVendorFile,
  declineAssignment,
  getAssignment,
  listAssignmentEvents,
  listAssignmentsFor,
  listClaimable,
  listPoolMembers,
  listVendors,
  moveAssignment,
  openVendorFile,
  postToPool,
  VENDOR_APPLICATION_ID,
  VENDOR_MIGRATIONS,
  VendorError,
} from './index.js';

let dir: string;
let path: string;
let db: Database;
let ana: number; // vendor ids, not account ids
let ben: number;
let cai: number;

const NOW = new Date('2026-03-01T10:00:00Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-assign-'));
  path = join(dir, 'vendors.ctv');
  db = createVendorFile(path, { generator: 'test' });
  const add = (accountId: number) => addVendor(db, { accountId, actor: TEST_ACTOR }).id;
  ana = add(10);
  ben = add(11);
  cai = add(12);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const owner = { ...TEST_ACTOR, label: 'owner' };
const vendorActor = (n: string) => ({ ...TEST_ACTOR, label: n });

const offer = (vendorId = ana) =>
  createDirectOffer(db, {
    projectName: 'brief',
    vendorId,
    deadline: '2026-03-10T17:00:00Z',
    instructions: ' Formal register. ',
    actor: owner,
    now: NOW,
  });

const pool = (vendorIds = [ana, ben, cai]) =>
  postToPool(db, { projectName: 'brief', vendorIds, actor: owner, now: NOW });

const claim = (c: Database, assignmentId: number, vendorId: number) =>
  claimAssignment(c, { assignmentId, vendorId, actor: vendorActor('v'), now: NOW });

describe('a direct offer', () => {
  it('is born offered to one named vendor, with its job and a first event', () => {
    const a = offer();
    expect(a).toMatchObject({
      projectName: 'brief',
      channel: 'direct',
      status: 'offered',
      vendorId: ana,
      deadline: '2026-03-10T17:00:00.000Z',
      instructions: 'Formal register.',
      reopenedFrom: null,
    });
    expect(listAssignmentEvents(db, a.id)).toMatchObject([
      { from: null, to: 'offered', actor: 'cli:test', actorLabel: 'owner' },
    ]);
  });

  it('goes the whole way, each move by the party that owns it, each in the log', () => {
    const a = offer();
    const move = (to: Parameters<typeof moveAssignment>[1]['to'], by: 'pm' | 'vendor') =>
      moveAssignment(db, {
        assignmentId: a.id,
        to,
        by,
        ...(by === 'vendor' ? { vendorId: ana } : {}),
        actor: by === 'pm' ? owner : vendorActor('ana'),
        now: NOW,
      });
    move('accepted', 'vendor');
    move('in_progress', 'vendor');
    move('delivered', 'vendor');
    const done = move('reviewed', 'pm');
    expect(done.status).toBe('reviewed');
    expect(
      listAssignmentEvents(db, a.id).map((e) => [e.from, e.to, e.actorLabel]),
    ).toEqual([
      [null, 'offered', 'owner'],
      ['offered', 'accepted', 'ana'],
      ['accepted', 'in_progress', 'ana'],
      ['in_progress', 'delivered', 'ana'],
      ['delivered', 'reviewed', 'owner'],
    ]);
  });

  it('refuses an edge that is not there and an edge that is the other party’s, changing nothing', () => {
    const a = offer();
    expect(() =>
      moveAssignment(db, {
        assignmentId: a.id,
        to: 'delivered',
        by: 'vendor',
        vendorId: ana,
        actor: TEST_ACTOR,
      }),
    ).toThrow(InvalidAssignmentTransitionError);
    expect(() =>
      moveAssignment(db, {
        assignmentId: a.id,
        to: 'accepted',
        by: 'pm',
        actor: TEST_ACTOR,
      }),
    ).toThrow(AssignmentPartyError);
    expect(getAssignment(db, a.id)?.status).toBe('offered');
    expect(listAssignmentEvents(db, a.id)).toHaveLength(1);
  });

  it('can only be answered by the vendor it was offered to', () => {
    const a = offer(ana);
    for (const other of [ben, cai]) {
      expect(() =>
        acceptAssignment(db, { assignmentId: a.id, vendorId: other, actor: TEST_ACTOR }),
      ).toThrow(AssignmentAccessError);
      expect(() =>
        declineAssignment(db, { assignmentId: a.id, vendorId: other, actor: TEST_ACTOR }),
      ).toThrow(AssignmentAccessError);
    }
    expect(getAssignment(db, a.id)?.status).toBe('offered');
    expect(() => claim(db, a.id, ana)).toThrow(AssignmentAccessError); // not a pool job
  });

  it('is declined for good: no repost, and the row keeps the vendor who declined', () => {
    const a = offer();
    const declined = declineAssignment(db, {
      assignmentId: a.id,
      vendorId: ana,
      note: 'on leave',
      actor: vendorActor('ana'),
      now: NOW,
    });
    expect(declined).toMatchObject({ status: 'declined', vendorId: ana });
    expect(listAssignmentEvents(db, a.id).at(-1)?.note).toBe('on leave');
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM assignment').get() as { n: number }).n,
    ).toBe(1);
  });

  it('refuses an unknown vendor, a blank project, a bad deadline and long instructions', () => {
    const base = { projectName: 'brief', vendorId: ana, actor: owner };
    expect(() => createDirectOffer(db, { ...base, vendorId: 999 })).toThrow(
      /no vendor #999/,
    );
    expect(() => createDirectOffer(db, { ...base, projectName: '  ' })).toThrow(
      VendorError,
    );
    expect(() => createDirectOffer(db, { ...base, deadline: 'next week' })).toThrow(
      /not a deadline/,
    );
    expect(() =>
      createDirectOffer(db, { ...base, instructions: 'x'.repeat(2001) }),
    ).toThrow(/at most 2000/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM assignment').get()).toEqual({ n: 0 });
  });
});

describe('a pool post', () => {
  it('is born pool_open with no vendor, and records who may claim it', () => {
    const a = pool([ana, ben]);
    expect(a).toMatchObject({ channel: 'pool', status: 'pool_open', vendorId: null });
    expect(listPoolMembers(db, a.id)).toEqual([ana, ben].sort());
    expect(() =>
      postToPool(db, { projectName: 'p', vendorIds: [], actor: owner }),
    ).toThrow(/at least one/);
    expect(() =>
      postToPool(db, { projectName: 'p', vendorIds: [999], actor: owner }),
    ).toThrow(/no vendor #999/);
  });

  it('lists a job as claimable to its members only, until it is claimed', () => {
    const a = pool([ana, ben]);
    expect(listClaimable(db, ana).map((x) => x.id)).toEqual([a.id]);
    expect(listClaimable(db, cai)).toEqual([]);
    claim(db, a.id, ana);
    expect(listClaimable(db, ben)).toEqual([]);
    expect(listAssignmentsFor(db, ana).map((x) => x.id)).toEqual([a.id]);
  });

  it('refuses a claim from a vendor who is not in the pool, changing nothing', () => {
    const a = pool([ana, ben]);
    expect(() => claim(db, a.id, cai)).toThrow(AssignmentAccessError);
    expect(getAssignment(db, a.id)).toMatchObject({
      status: 'pool_open',
      vendorId: null,
    });
    expect(listAssignmentEvents(db, a.id)).toHaveLength(1);
  });

  it('done when: two claims on one pool job leave exactly one claimed row and one rejection', () => {
    const a = pool();
    const results = [ana, ben].map((vendorId) => {
      try {
        return { ok: true as const, assignment: claim(db, a.id, vendorId) };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const lost = results.find((r) => !r.ok)!;
    expect(lost.ok === false && lost.error).toBeInstanceOf(
      InvalidAssignmentTransitionError,
    );

    const rows = db
      .prepare("SELECT vendor_id FROM assignment WHERE status = 'claimed'")
      .all();
    expect(rows).toHaveLength(1);
    expect(listAssignmentEvents(db, a.id).filter((e) => e.to === 'claimed')).toHaveLength(
      1,
    );
    expect(getAssignment(db, a.id)?.vendorId).toBe(ana);
  });

  it('holds across two connections to the same file, not only inside one', () => {
    const a = pool();
    const other = openVendorFile(path);
    try {
      const first = claim(db, a.id, ana);
      expect(first.status).toBe('claimed');
      expect(() => claim(other, a.id, ben)).toThrow(InvalidAssignmentTransitionError);
      expect(getAssignment(other, a.id)).toMatchObject({
        status: 'claimed',
        vendorId: ana,
      });
    } finally {
      other.close();
    }
  });

  it('does not let a member who lost accept, decline or move what someone else claimed', () => {
    const a = pool();
    claim(db, a.id, ana);
    expect(() =>
      acceptAssignment(db, { assignmentId: a.id, vendorId: ben, actor: TEST_ACTOR }),
    ).toThrow(AssignmentAccessError);
    expect(() =>
      declineAssignment(db, { assignmentId: a.id, vendorId: ben, actor: TEST_ACTOR }),
    ).toThrow(AssignmentAccessError);
    expect(getAssignment(db, a.id)?.status).toBe('claimed');
  });

  it('lets the claimant accept, and carries on as any assignment does', () => {
    const a = pool();
    claim(db, a.id, ben);
    expect(
      acceptAssignment(db, { assignmentId: a.id, vendorId: ben, actor: TEST_ACTOR })
        .status,
    ).toBe('accepted');
  });
});

describe('a declined claim', () => {
  it('is terminal on its row and reposts the same job to the rest of the pool, once', () => {
    const a = pool([ana, ben, cai]);
    claim(db, a.id, ana);
    declineAssignment(db, {
      assignmentId: a.id,
      vendorId: ana,
      actor: vendorActor('ana'),
      now: NOW,
    });

    expect(getAssignment(db, a.id)).toMatchObject({ status: 'declined', vendorId: ana });
    const reposted = db
      .prepare('SELECT * FROM assignment WHERE reopened_from = ?')
      .all(a.id) as Array<{ id: number; status: string; vendor_id: number | null }>;
    expect(reposted).toHaveLength(1);
    expect(reposted[0]).toMatchObject({ status: 'pool_open', vendor_id: null });
    const again = getAssignment(db, reposted[0]!.id)!;
    expect(again).toMatchObject({
      projectName: 'brief',
      reopenedFrom: a.id,
      channel: 'pool',
    });
    expect(listPoolMembers(db, again.id)).toEqual([ben, cai].sort());
    expect(listClaimable(db, ana)).toEqual([]);
    expect(listClaimable(db, ben).map((x) => x.id)).toEqual([again.id]);
    expect(listAssignmentEvents(db, again.id)[0]).toMatchObject({
      from: null,
      to: 'pool_open',
      note: `reposted after #${a.id} was declined`,
    });
  });

  it('is reposted again if the next claimant declines too, and not when nobody is left', () => {
    const a = pool([ana, ben]);
    claim(db, a.id, ana);
    declineAssignment(db, { assignmentId: a.id, vendorId: ana, actor: TEST_ACTOR });
    const second = listClaimable(db, ben)[0]!;
    claim(db, second.id, ben);
    declineAssignment(db, { assignmentId: second.id, vendorId: ben, actor: TEST_ACTOR });
    expect(listClaimable(db, ana)).toEqual([]);
    expect(listClaimable(db, ben)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM assignment').get()).toEqual({ n: 2 });
  });

  it('is not a move that loses the vendors’ own history: each row keeps its events', () => {
    const a = pool();
    claim(db, a.id, ana);
    declineAssignment(db, { assignmentId: a.id, vendorId: ana, actor: TEST_ACTOR });
    expect(listAssignmentEvents(db, a.id).map((e) => e.to)).toEqual([
      'pool_open',
      'claimed',
      'declined',
    ]);
  });
});

describe('the log and the table', () => {
  it('assignment_event is append-only by trigger, except for erasing a label', () => {
    const a = offer();
    expect(() => db.prepare('DELETE FROM assignment_event').run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE assignment_event SET note = 'x'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("UPDATE assignment_event SET actor = 'cli:x'").run()).toThrow(
      /append-only/,
    );
    expect(() =>
      db.prepare("UPDATE assignment_event SET actor_label = 'someone'").run(),
    ).toThrow(/append-only/);
    db.prepare("UPDATE assignment_event SET actor_label = '[erased]'").run();
    expect(listAssignmentEvents(db, a.id)[0]?.actorLabel).toBe('[erased]');
  });

  it('every event names an actor: the column is required and has no default', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO assignment_event (assignment_id, to_status, at) VALUES (1, 'offered', 'now')",
        )
        .run(),
    ).toThrow(/NOT NULL/);
  });

  it('refuses a pool_open row with a vendor and any other status without one, whoever writes it', () => {
    const insert = (status: string, vendorId: number | null) =>
      db
        .prepare(
          `INSERT INTO assignment (project_name, channel, status, vendor_id, created_at, updated_at)
           VALUES ('p', 'pool', ?, ?, 'n', 'n')`,
        )
        .run(status, vendorId);
    expect(() => insert('pool_open', ana)).toThrow(/CHECK/);
    expect(() => insert('claimed', null)).toThrow(/CHECK/);
    expect(() => insert('lost', ana)).toThrow(/CHECK/);
  });
});

describe('the migration', () => {
  it('adds assignments to a roster file written at version 1, keeping its vendors', () => {
    const v1 = join(dir, 'old.ctv');
    const old = openAndMigrate(v1, {
      applicationId: VENDOR_APPLICATION_ID,
      migrations: VENDOR_MIGRATIONS.slice(0, 1),
    });
    old
      .prepare(
        "INSERT INTO vendor (account_id, display_name, created_at, updated_at) VALUES (5, 'Old', 'n', 'n')",
      )
      .run();
    old.close();
    const migrated = openVendorFile(v1);
    expect(migrated.pragma('user_version', { simple: true })).toBe(2);
    expect(listVendors(migrated)).toHaveLength(1);
    expect(migrated.prepare('SELECT COUNT(*) AS n FROM assignment').get()).toEqual({
      n: 0,
    });
    migrated.close();
  });

  it('is still its own kind of file', () => {
    const foreign = new SqliteDatabase(join(dir, 'foreign.ctv'));
    foreign.pragma('application_id = 1112754007');
    foreign.close();
    expect(() => openVendorFile(join(dir, 'foreign.ctv'))).toThrow(/not one of ours/);
  });
});
