/** Reconciling grants with assignment status (backlog #121; vendor-spec.md's #121 note). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents } from '../audit/events.js';
import { createAccount, type Account } from '../platform/accounts.js';
import {
  grantProjectAuthorization,
  listAuthorizationsByOwner,
  revokeProjectAuthorization,
  scopeOf,
} from '../platform/authorization.js';
import { listRosterOwners } from '../platform/membership.js';
import { openPlatformDb } from '../platform/index.js';
import {
  acceptAssignment,
  addVendor,
  createDirectOffer,
  createVendorFile,
  declineAssignment,
  moveAssignment,
  postToPool,
  reconcileAssignmentGrants,
  reconcileMemberships,
} from './index.js';

const NOW = new Date('2026-03-01T10:00:00Z');
const runner = { ...TEST_ACTOR, label: 'owner' };

let dir: string;
let roster: Database.Database;
let platform: Database.Database;
let owner: Account;
let ana: Account;
let ben: Account;
let anaId: number; // roster ids
let benId: number;

const account = (email: string, role?: 'vendor'): Account =>
  createAccount(platform, {
    email,
    passwordHash: 'h',
    actor: TEST_ACTOR,
    ...(role ? { role } : {}),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-reconcile-'));
  platform = openPlatformDb(join(dir, 'platform.sqlite'));
  roster = createVendorFile(join(dir, 'vendors.ctv'), { generator: 'test' });
  owner = account('owner@example.com');
  ana = account('ana@example.com', 'vendor');
  ben = account('ben@example.com', 'vendor');
  anaId = addVendor(roster, { accountId: ana.id, actor: TEST_ACTOR }).id;
  benId = addVendor(roster, { accountId: ben.id, actor: TEST_ACTOR }).id;
});
afterEach(() => {
  roster.close();
  platform.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const offer = (vendorId: number, project = 'p1') =>
  createDirectOffer(roster, { projectName: project, vendorId, actor: runner, now: NOW });
const accept = (id: number, vendorId: number) =>
  acceptAssignment(roster, { assignmentId: id, vendorId, actor: runner, now: NOW });
const walk = (
  id: number,
  vendorId: number,
  ...to: Array<'in_progress' | 'delivered'>
) => {
  for (const t of to) {
    moveAssignment(roster, {
      assignmentId: id,
      vendorId,
      to: t,
      by: 'vendor',
      actor: runner,
      now: NOW,
    });
  }
};
const review = (id: number) =>
  moveAssignment(roster, {
    assignmentId: id,
    to: 'reviewed',
    by: 'pm',
    actor: runner,
    now: NOW,
  });
const grant = (a: Account, project = 'p1', ownerId = owner.id) =>
  grantProjectAuthorization(platform, {
    accountId: a.id,
    project: { accountId: ownerId, name: project },
    scope: 'assigned_translator',
    actor: TEST_ACTOR,
  });
const holds = (a: Account, project = 'p1') =>
  scopeOf(platform, a.id, { accountId: owner.id, name: project }) !== null;
const run = () =>
  reconcileAssignmentGrants(roster, platform, { ownerId: owner.id, actor: runner });

describe('reconcileAssignmentGrants', () => {
  it('grants a vendor whose accept left them without access, and a second run changes nothing', () => {
    const a = offer(anaId);
    accept(a.id, anaId); // the grant that should have followed never happened
    expect(holds(ana)).toBe(false);

    expect(run()).toEqual({
      granted: [{ accountId: ana.id, project: 'p1' }],
      revoked: [],
      skipped: [],
    });
    expect(holds(ana)).toBe(true);

    const events = () =>
      listEvents(platform, { subjectType: 'project', subjectId: `${owner.id}/p1` })
        .length;
    const before = events();
    expect(run()).toEqual({ granted: [], revoked: [], skipped: [] });
    expect(events()).toBe(before); // nothing wrong, nothing written
  });

  it('ends the access a failed revoke left on a reviewed job', () => {
    const a = offer(anaId);
    accept(a.id, anaId);
    grant(ana);
    walk(a.id, anaId, 'in_progress', 'delivered');
    review(a.id); // reviewed is terminal: repeating the review cannot revoke
    expect(holds(ana)).toBe(true);

    expect(run()).toEqual({
      granted: [],
      revoked: [{ accountId: ana.id, project: 'p1' }],
      skipped: [],
    });
    expect(holds(ana)).toBe(false);
  });

  it('keeps the grant while any assignment of the vendor on the project is active', () => {
    const first = offer(anaId);
    accept(first.id, anaId);
    walk(first.id, anaId, 'in_progress', 'delivered');
    review(first.id);
    const second = offer(anaId); // a second job on the same project
    accept(second.id, anaId);
    grant(ana);
    expect(run()).toEqual({ granted: [], revoked: [], skipped: [] });
    expect(holds(ana)).toBe(true);
  });

  it('ends the access of a vendor who declined, and gives none for an offer not answered or a pool job unclaimed', () => {
    const declined = offer(anaId, 'p1');
    declineAssignment(roster, {
      assignmentId: declined.id,
      vendorId: anaId,
      actor: runner,
      now: NOW,
    });
    grant(ana, 'p1');
    offer(benId, 'p2'); // offered, not answered
    postToPool(roster, {
      projectName: 'p3',
      vendorIds: [anaId, benId],
      actor: runner,
      now: NOW,
    });
    expect(run()).toEqual({
      granted: [],
      revoked: [{ accountId: ana.id, project: 'p1' }],
      skipped: [],
    });
    expect(holds(ben, 'p2')).toBe(false);
    expect(holds(ana, 'p3')).toBe(false);
  });

  it('leaves alone a grant the roster has never heard of, and another owner’s projects', () => {
    grant(ben, 'unrelated'); // no assignment on it
    const other = account('other@example.com');
    grantProjectAuthorization(platform, {
      accountId: ana.id,
      project: { accountId: other.id, name: 'p1' },
      scope: 'assigned_translator',
      actor: TEST_ACTOR,
    });
    expect(run()).toEqual({ granted: [], revoked: [], skipped: [] });
    expect(holds(ben, 'unrelated')).toBe(true);
    expect(listAuthorizationsByOwner(platform, other.id)).toHaveLength(1);
  });

  it('reports a grant it cannot make as skipped and still mends the rest', () => {
    const ghost = addVendor(roster, { accountId: 999_999, actor: TEST_ACTOR }).id; // no such account
    const g = offer(ghost, 'pg');
    accept(g.id, ghost);
    const a = offer(anaId);
    accept(a.id, anaId);
    const result = run();
    expect(result.granted).toEqual([{ accountId: ana.id, project: 'p1' }]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ accountId: 999_999, project: 'pg' });
    expect(result.skipped[0]!.reason).toMatch(/no account/);
  });

  it('logs each repair as an ordinary authorization event under the actor that ran it', () => {
    const a = offer(anaId);
    accept(a.id, anaId);
    run();
    const [event] = listEvents(platform, {
      subjectType: 'project',
      subjectId: `${owner.id}/p1`,
    }).filter((e) => e.action === 'authorization.granted');
    expect(event).toMatchObject({ action: 'authorization.granted', actorLabel: 'owner' });
  });

  it('after a revoke by hand it grants again: the roster, not the table, is the truth', () => {
    const a = offer(anaId);
    accept(a.id, anaId);
    run();
    revokeProjectAuthorization(platform, {
      accountId: ana.id,
      project: { accountId: owner.id, name: 'p1' },
      actor: TEST_ACTOR,
    });
    expect(run().granted).toHaveLength(1);
    expect(holds(ana)).toBe(true);
  });
});

describe('reconcileMemberships', () => {
  it('indexes every vendor on the roster, once, and a second run adds nothing', () => {
    expect(reconcileMemberships(roster, platform, owner.id).sort()).toEqual(
      [ana.id, ben.id].sort(),
    );
    expect(listRosterOwners(platform, ana.id)).toEqual([owner.id]);
    expect(listRosterOwners(platform, ben.id)).toEqual([owner.id]);
    expect(reconcileMemberships(roster, platform, owner.id)).toEqual([]);
  });

  it('skips a vendor whose account no longer exists, and indexes the rest', () => {
    addVendor(roster, { accountId: 999_999, actor: TEST_ACTOR });
    expect(reconcileMemberships(roster, platform, owner.id).sort()).toEqual(
      [ana.id, ben.id].sort(),
    );
  });
});
