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
});
