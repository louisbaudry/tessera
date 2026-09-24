import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openPlatformDb } from './index.js';
import { PLATFORM_APPLICATION_ID } from './schema.js';
import { PROJECT_APPLICATION_ID } from '../project/schema.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-platform-'));
  return join(dir, 'platform.sqlite');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('openPlatformDb', () => {
  it('is a distinct file type from the project database', () => {
    expect(PLATFORM_APPLICATION_ID).not.toBe(PROJECT_APPLICATION_ID);
    const db = openPlatformDb(dbPath());
    expect(db.pragma('application_id', { simple: true })).toBe(PLATFORM_APPLICATION_ID);
    db.close();
  });

  it('enforces one account per email and one storage root per account', () => {
    const db = openPlatformDb(dbPath());
    const insert = db.prepare(
      'INSERT INTO account (email, password_hash, storage_root, created_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('me@example.com', 'hash', 'u/1', '2026-01-01');
    expect(() => insert.run('me@example.com', 'hash2', 'u/2', '2026-01-01')).toThrow();
    expect(() => insert.run('other@example.com', 'hash', 'u/1', '2026-01-01')).toThrow();
    db.close();
  });

  it('carries the shared, append-only audit_event from v3 (backlog #57)', () => {
    const db = openPlatformDb(dbPath());
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all();
    expect(triggers).toEqual([
      { name: 'audit_event_no_delete' },
      { name: 'audit_event_no_update' },
    ]);
    db.close();
  });
});
