/** A portal client's vendor pool (vendor-spec.md, the #156 note). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents } from '../audit/events.js';
import {
  addVendor,
  assessRoster,
  createVendorFile,
  getClientPool,
  listClientPools,
  setClientPool,
  setCapacity,
} from './index.js';

let dir: string;
let roster: Database;
let ids: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-client-pools-'));
  roster = createVendorFile(join(dir, 'vendors.ctv'), { generator: 'test' });
  ids = [1, 2, 3].map(
    (accountId) =>
      addVendor(roster, {
        accountId,
        languages: [{ src: 'en', tgt: 'de' }],
        actor: TEST_ACTOR,
      }).id,
  );
});
afterEach(() => {
  roster.close();
  rmSync(dir, { recursive: true, force: true });
});

const events = () =>
  listEvents(roster, { subjectType: 'client_pool' }).map((e) => ({
    subjectId: e.subjectId,
    detail: JSON.parse(e.detail as string) as { added: number[]; removed: number[] },
  }));

describe('a client’s pool', () => {
  it('is empty until one is set, and set as a whole, each change logged with who joined and left', () => {
    expect(getClientPool(roster, 7)).toEqual([]);
    setClientPool(roster, {
      portalClientId: 7,
      vendorIds: [ids[1]!, ids[0]!],
      actor: TEST_ACTOR,
    });
    expect(getClientPool(roster, 7)).toEqual([ids[0], ids[1]]);
    const change = setClientPool(roster, {
      portalClientId: 7,
      vendorIds: [ids[1]!, ids[2]!],
      actor: TEST_ACTOR,
    });
    expect(change).toEqual({ added: [ids[2]], removed: [ids[0]] });
    expect(events()).toEqual([
      {
        subjectId: '7',
        detail: expect.objectContaining({ added: [ids[0], ids[1]], removed: [] }),
      },
      {
        subjectId: '7',
        detail: expect.objectContaining({ added: [ids[2]], removed: [ids[0]] }),
      },
    ]);
  });

  it('is cleared by an empty list, and a call that changes nothing logs nothing', () => {
    setClientPool(roster, { portalClientId: 7, vendorIds: [ids[0]!], actor: TEST_ACTOR });
    setClientPool(roster, { portalClientId: 7, vendorIds: [ids[0]!], actor: TEST_ACTOR });
    expect(events()).toHaveLength(1);
    setClientPool(roster, { portalClientId: 7, vendorIds: [], actor: TEST_ACTOR });
    expect(getClientPool(roster, 7)).toEqual([]);
    expect(events()).toHaveLength(2);
  });

  it('keeps clients apart and lists the pools there are', () => {
    setClientPool(roster, { portalClientId: 7, vendorIds: [ids[0]!], actor: TEST_ACTOR });
    setClientPool(roster, {
      portalClientId: 9,
      vendorIds: [ids[1]!, ids[2]!],
      actor: TEST_ACTOR,
    });
    expect(listClientPools(roster)).toEqual([
      { portalClientId: 7, vendorIds: [ids[0]] },
      { portalClientId: 9, vendorIds: [ids[1], ids[2]] },
    ]);
  });

  it('refuses a vendor not on the roster or a bad client, and writes nothing', () => {
    expect(() =>
      setClientPool(roster, {
        portalClientId: 7,
        vendorIds: [ids[0]!, 99],
        actor: TEST_ACTOR,
      }),
    ).toThrow(/no vendor #99/);
    expect(() =>
      setClientPool(roster, { portalClientId: 0, vendorIds: [], actor: TEST_ACTOR }),
    ).toThrow(/positive whole number/);
    expect(getClientPool(roster, 7)).toEqual([]);
    expect(events()).toEqual([]);
  });
});

describe('assessRoster with a project’s client', () => {
  const job = { src: 'en', tgt: 'de' };

  it('names the vendors outside the client’s pool, and no one when the client has none', () => {
    setClientPool(roster, { portalClientId: 7, vendorIds: [ids[0]!], actor: TEST_ACTOR });
    expect(
      assessRoster(roster, job, { portalClientId: 7 }).map((f) => [
        f.accountId,
        f.reasons,
      ]),
    ).toEqual([
      [1, []],
      [2, ['not_in_client_pool']],
      [3, ['not_in_client_pool']],
    ]);
    // A client nobody has a pool for, no client, and no pool at all: no restriction.
    for (const portalClientId of [8, null, undefined]) {
      expect(
        assessRoster(roster, job, { portalClientId }).flatMap((f) => f.reasons),
      ).toEqual([]);
    }
    expect(assessRoster(roster, job).flatMap((f) => f.reasons)).toEqual([]);
  });

  it('adds to the other reasons, and an emptied pool restricts no one again', () => {
    setClientPool(roster, { portalClientId: 7, vendorIds: [ids[0]!], actor: TEST_ACTOR });
    setCapacity(roster, { vendorId: ids[1]!, status: 'busy' });
    expect(assessRoster(roster, job, { portalClientId: 7 })[1]!.reasons).toEqual([
      'busy',
      'not_in_client_pool',
    ]);
    setClientPool(roster, { portalClientId: 7, vendorIds: [], actor: TEST_ACTOR });
    expect(assessRoster(roster, job, { portalClientId: 7 })[1]!.reasons).toEqual([
      'busy',
    ]);
  });
});
