import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createClient,
  createOrder,
  insertSourceFile,
  listOrderEvents,
  openPortalDb,
  setRate,
  setStatus,
  setWordCountAndPrice,
} from './index.js';
import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { PORTAL_APPLICATION_ID } from './schema.js';
import { PLATFORM_APPLICATION_ID } from '../platform/schema.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-'));
  return join(dir, 'portal.sqlite');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('openPortalDb', () => {
  it('is a distinct file type from the platform database', () => {
    expect(PORTAL_APPLICATION_ID).not.toBe(PLATFORM_APPLICATION_ID);
    const db = openPortalDb(dbPath());
    expect(db.pragma('application_id', { simple: true })).toBe(PORTAL_APPLICATION_ID);
    db.close();
  });

  it('carries append-only order_event and audit_event from v3 (backlog #58)', () => {
    const db = openPortalDb(dbPath());
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all();
    expect(triggers).toEqual([
      { name: 'audit_event_no_delete' },
      { name: 'audit_event_no_update' },
      { name: 'order_event_no_delete' },
      { name: 'order_event_no_update' },
    ]);
    db.close();
  });

  it('enforces one client per email and one access token per client', () => {
    const db = openPortalDb(dbPath());
    createClient(db, 'Ada', 'ada@client.example', 'tok-1');
    expect(() => createClient(db, 'Ada 2', 'ada@client.example', 'tok-2')).toThrow();
    expect(() =>
      createClient(db, 'Someone Else', 'other@example.com', 'tok-1'),
    ).toThrow();
    db.close();
  });

  it('creates an order with target languages and a creation event', () => {
    const db = openPortalDb(dbPath());
    const client = createClient(db, 'Ada', 'ada@client.example', 'tok-1');
    const order = createOrder(
      db,
      {
        clientId: client.id,
        srcLang: 'en',
        tgtLangs: ['fr', 'es'],
        notes: 'brochure text',
      },
      { actor: TEST_ACTOR },
    );
    expect(order.status).toBe('submitted');
    expect(order.tgtLangs).toEqual(['es', 'fr']);
    expect(order.wordCount).toBeNull();
    expect(order.price).toBeNull();

    const events = listOrderEvents(db, order.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: null, toStatus: 'submitted' });
    db.close();
  });

  it('records a status transition as an order_event and rejects illegal ones', () => {
    const db = openPortalDb(dbPath());
    const client = createClient(db, 'Ada', 'ada@client.example', 'tok-1');
    const order = createOrder(
      db,
      {
        clientId: client.id,
        srcLang: 'en',
        tgtLangs: ['fr'],
      },
      { actor: TEST_ACTOR },
    );

    const approved = setStatus(db, order.id, 'approved', { actor: TEST_ACTOR });
    expect(approved.status).toBe('approved');

    expect(() => setStatus(db, order.id, 'delivered', { actor: TEST_ACTOR })).toThrow();

    const events = listOrderEvents(db, order.id);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ fromStatus: 'submitted', toStatus: 'approved' });
    db.close();
  });

  it('sets word count and price, and stores source files with metadata', () => {
    const db = openPortalDb(dbPath());
    setRate(db, { srcLang: 'en', tgtLang: 'fr', ratePerWord: 0.12, minimumPrice: 50 });
    const client = createClient(db, 'Ada', 'ada@client.example', 'tok-1');
    const order = createOrder(
      db,
      {
        clientId: client.id,
        srcLang: 'en',
        tgtLangs: ['fr'],
      },
      { actor: TEST_ACTOR },
    );

    const priced = setWordCountAndPrice(db, order.id, 1000, 120);
    expect(priced.wordCount).toBe(1000);
    expect(priced.price).toBe(120);

    const file = insertSourceFile(db, {
      orderId: order.id,
      filename: 'brochure.docx',
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byteSize: 12345,
      storagePath: `orders/${order.id}/source/brochure.docx`,
    });
    expect(file.orderId).toBe(order.id);
    expect(file.byteSize).toBe(12345);
    db.close();
  });
});
