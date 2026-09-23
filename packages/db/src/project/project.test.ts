import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openProjectDb } from './index.js';
import { createProject, getProject, ProjectError } from './project.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-project-repo-'));
  return join(dir, 'project.catdb');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('createProject / getProject', () => {
  it('writes and reads back the identity row', () => {
    const db = openProjectDb(dbPath());
    const created = createProject(db, { name: 'Client X', srcLang: 'en', tgtLang: 'es' });
    expect(created).toEqual({
      name: 'Client X',
      srcLang: 'en',
      tgtLang: 'es',
      createdAt: created.createdAt,
      // The version this build writes, so the row never lies about which
      // schema its file actually has.
      schemaVersion: db.pragma('user_version', { simple: true }),
    });
    expect(getProject(db)).toEqual(created);
    db.close();
  });

  it('returns null before a project has been created', () => {
    const db = openProjectDb(dbPath());
    expect(getProject(db)).toBeNull();
    db.close();
  });

  it('refuses a second identity row', () => {
    const db = openProjectDb(dbPath());
    createProject(db, { name: 'first', srcLang: 'en', tgtLang: 'es' });
    expect(() =>
      createProject(db, { name: 'second', srcLang: 'en', tgtLang: 'fr' }),
    ).toThrow(ProjectError);
    db.close();
  });
});
