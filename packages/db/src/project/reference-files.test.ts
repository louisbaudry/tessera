import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REFERENCE_MAX_BYTES, REFERENCE_MAX_FILES } from '@cat-tool/core';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import { openProjectDb } from './index.js';
import { createProject } from './project.js';
import {
  addReferenceFile,
  getReferenceFile,
  listReferenceFiles,
  ReferenceFileError,
  removeReferenceFile,
} from './reference-files.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function project() {
  dir = mkdtempSync(join(tmpdir(), 'cat-ref-'));
  const db = openProjectDb(join(dir, 'p.catdb'));
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'de' });
  return db;
}

const pdf = (extra = '') => new TextEncoder().encode(`%PDF-1.7\n${extra}`);

describe('reference files', () => {
  it('stores a file with its type read from the bytes, and gives the bytes back', () => {
    const db = project();
    const added = addReferenceFile(db, {
      name: 'C:\\Clients\\Acme\\Style guide.pdf',
      label: ' Style guide ',
      bytes: pdf('one'),
      actor: TEST_ACTOR,
    });
    expect(added).toMatchObject({
      id: 1,
      name: 'Style guide.pdf',
      label: 'Style guide',
      mediaType: 'application/pdf',
      size: pdf('one').length,
    });
    expect(listReferenceFiles(db)).toEqual([added]);
    const got = getReferenceFile(db, added.id)!;
    expect(got.file).toEqual(added);
    expect(Buffer.from(got.data).equals(Buffer.from(pdf('one')))).toBe(true);
    expect(getReferenceFile(db, 99)).toBeNull();
    db.close();
  });

  it('trusts the bytes, not the name: a script renamed .pdf is refused', () => {
    const db = project();
    expect(() =>
      addReferenceFile(db, {
        name: 'guide.pdf',
        bytes: new TextEncoder().encode('<script>alert(1)</script>'),
        actor: TEST_ACTOR,
      }),
    ).toThrow(expect.objectContaining({ reason: 'type' }));
    expect(listReferenceFiles(db)).toEqual([]);
    db.close();
  });

  it('refuses an empty file, a big one, a long label and a twenty-first file', () => {
    const db = project();
    const refusal = (fn: () => unknown, reason: string) =>
      expect(fn).toThrow(expect.objectContaining({ name: 'ReferenceFileError', reason }));
    refusal(
      () =>
        addReferenceFile(db, {
          name: 'a.pdf',
          bytes: new Uint8Array(),
          actor: TEST_ACTOR,
        }),
      'empty',
    );
    const big = new Uint8Array(REFERENCE_MAX_BYTES + 1);
    big.set(pdf());
    refusal(
      () => addReferenceFile(db, { name: 'a.pdf', bytes: big, actor: TEST_ACTOR }),
      'too_big',
    );
    refusal(
      () =>
        addReferenceFile(db, {
          name: 'a.pdf',
          label: 'x'.repeat(81),
          bytes: pdf(),
          actor: TEST_ACTOR,
        }),
      'label',
    );
    for (let i = 0; i < REFERENCE_MAX_FILES; i++) {
      addReferenceFile(db, {
        name: `f${i}.pdf`,
        bytes: pdf(String(i)),
        actor: TEST_ACTOR,
      });
    }
    refusal(
      () => addReferenceFile(db, { name: 'x.pdf', bytes: pdf(), actor: TEST_ACTOR }),
      'too_many',
    );
    expect(listReferenceFiles(db)).toHaveLength(REFERENCE_MAX_FILES);
    expect(ReferenceFileError.name).toBe('ReferenceFileError');
    db.close();
  });

  it('logs adding and removing with size and digest, never the name or label, on a chain that verifies', () => {
    const db = project();
    const added = addReferenceFile(db, {
      name: 'Acme brief.pdf',
      label: 'Acme brief',
      bytes: pdf(),
      actor: TEST_ACTOR,
    });
    expect(removeReferenceFile(db, added.id, { actor: TEST_ACTOR })).toBe(true);
    expect(removeReferenceFile(db, added.id, { actor: TEST_ACTOR })).toBe(false);
    expect(listReferenceFiles(db)).toEqual([]);

    const events = listEvents(db, { subjectType: 'reference_file' });
    expect(events.map((e) => e.action)).toEqual(['reference.added', 'reference.removed']);
    for (const e of events) {
      expect(JSON.stringify(e)).not.toContain('Acme');
      expect(e.subjectId).toBe('1');
    }
    expect(JSON.parse(events[0]!.detail as string)).toMatchObject({
      media_type: 'application/pdf',
      sha256: added.sha256,
    });
    expect(verifyAudit(db)).toMatchObject({ events: 2, brokenAt: null });
    db.close();
  });
});
