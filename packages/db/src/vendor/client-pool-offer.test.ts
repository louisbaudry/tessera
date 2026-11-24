/**
 * A client's vendor pool holds at offer time (issue #403, vendor-spec.md's #403
 * note): an offer or a pool post naming a vendor outside the project's client's
 * pool is refused unless the owner overrides it, and an override is logged in the
 * roster's own `audit_event`, in the offer's transaction.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents } from '../audit/events.js';
import {
  addVendor,
  ClientPoolError,
  createDirectOffer,
  createVendorFile,
  listAssignmentsFor,
  postToPool,
  setClientPool,
} from './index.js';

let dir: string;
let db: Database;
let ana: number;
let ben: number;
const CLIENT = 7;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-client-pool-offer-'));
  db = createVendorFile(join(dir, 'vendors.ctv'), { generator: 'test' });
  ana = addVendor(db, { accountId: 10, actor: TEST_ACTOR }).id;
  ben = addVendor(db, { accountId: 11, actor: TEST_ACTOR }).id;
  setClientPool(db, { portalClientId: CLIENT, vendorIds: [ana], actor: TEST_ACTOR });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const job = { projectName: 'p', actor: TEST_ACTOR };
const overrides = () =>
  listEvents(db, { subjectType: 'assignment' }).filter(
    (e) => e.action === 'client_pool.overridden',
  );

describe('a client pool at offer time', () => {
  it('refuses a direct offer to a vendor outside the pool, and writes nothing', () => {
    const attempt = () =>
      createDirectOffer(db, {
        ...job,
        vendorId: ben,
        clientPool: { portalClientId: CLIENT },
      });
    expect(attempt).toThrow(ClientPoolError);
    try {
      attempt();
    } catch (err) {
      expect((err as ClientPoolError).outside).toEqual([ben]);
    }
    expect(listAssignmentsFor(db, ben)).toEqual([]);
    expect(overrides()).toEqual([]);
  });

  it('refuses a pool post naming anyone outside the pool', () => {
    expect(() =>
      postToPool(db, {
        ...job,
        vendorIds: [ana, ben],
        clientPool: { portalClientId: CLIENT },
      }),
    ).toThrow(ClientPoolError);
  });

  it('lets an offer inside the pool through, and logs no override', () => {
    createDirectOffer(db, {
      ...job,
      vendorId: ana,
      clientPool: { portalClientId: CLIENT, override: true },
    });
    expect(overrides()).toEqual([]);
  });

  it('lets an owner override, and logs which vendors were outside', () => {
    const a = postToPool(db, {
      ...job,
      vendorIds: [ana, ben],
      clientPool: { portalClientId: CLIENT, override: true },
    });
    const logged = overrides();
    expect(logged).toHaveLength(1);
    expect(logged[0]!.subjectId).toBe(String(a.id));
    expect(JSON.parse(logged[0]!.detail!)).toEqual({
      assignment_id: a.id,
      client_id: CLIENT,
      vendor_ids: [ben],
    });
  });

  it('restricts nothing for a client with no pool, or a project with no client', () => {
    createDirectOffer(db, { ...job, vendorId: ben, clientPool: { portalClientId: 8 } });
    createDirectOffer(db, {
      ...job,
      vendorId: ben,
      clientPool: { portalClientId: null },
    });
    createDirectOffer(db, { ...job, vendorId: ben });
    expect(listAssignmentsFor(db, ben)).toHaveLength(3);
    expect(overrides()).toEqual([]);
  });
});
