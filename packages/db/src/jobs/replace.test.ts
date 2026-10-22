/**
 * The find-and-replace jobs through the real worker thread (`v1-spec.md` §7.8): the
 * scan and the apply produce what the repository functions do, and a pattern that
 * would hang a thread is ended by the runner's terminate, leaving the project as it was.
 * The hang is the point: it is the reason these are jobs and not requests.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleFile, plainText, rulesFor, type Token } from '@cat-tool/core';
import { afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { insertFile } from '../project/files.js';
import { openProjectDb } from '../project/index.js';
import { createProject } from '../project/project.js';
import { getSegment, listSegments, setSegmentTarget } from '../project/segments.js';
import { startJob } from './run.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  dir = undefined;
});

const text = (v: string): Token => ({ t: 'text', v });

/** A project file with the first segments translated as given; returns its path and segment ids. */
function project(targets: string[]): { path: string; ids: number[] } {
  dir = mkdtempSync(join(tmpdir(), 'cat-replace-job-'));
  const path = join(dir, 'project.catdb');
  const db = openProjectDb(path);
  createProject(db, { name: 'p', srcLang: 'en', tgtLang: 'es' });
  insertFile(
    db,
    'a.docx',
    assembleFile(
      new Uint8Array(readFileSync(join(FIXTURES, 'form-minimal.docx'))),
      rulesFor('en'),
    ),
    { actor: TEST_ACTOR },
  );
  const segments = listSegments(db, 1).filter((s) => !s.locked);
  const ids = targets.map((t, i) => {
    setSegmentTarget(db, segments[i]!.id, {
      targetTokens: [text(t)],
      status: 'translated',
      origin: null,
      actor: TEST_ACTOR,
    });
    return segments[i]!.id;
  });
  db.close();
  return { path, ids };
}

describe('the find-and-replace jobs', () => {
  it('scan, then apply what the scan showed', async () => {
    const { path, ids } = project(['Abra la tapa.', 'Cierre la ventana.']);
    const find = { pattern: 'tapa', regex: false, caseSensitive: false };

    const scanned = await startJob('project.replaceScan', {
      projectPath: path,
      find,
      replacement: 'cubierta',
    }).done;
    expect(scanned.status).toBe('done');
    const scan = scanned.status === 'done' ? scanned.value : null;
    expect(scan?.proposals.map((p) => p.segmentId)).toEqual([ids[0]]);

    const applied = await startJob('project.replaceApply', {
      projectPath: path,
      find,
      replacement: 'cubierta',
      chosen: scan!.proposals.map((p) => ({
        segmentId: p.segmentId,
        updatedAt: p.updatedAt,
      })),
      actor: TEST_ACTOR,
    }).done;
    expect(applied.status === 'done' && applied.value).toMatchObject({
      segments: 1,
      matches: 1,
    });

    const db = openProjectDb(path);
    expect(plainText(getSegment(db, ids[0]!)!.targetTokens ?? [])).toBe(
      'Abra la cubierta.',
    );
    db.close();
  });

  it('terminates a pattern that would hang, and the project is as it was', async () => {
    // Nested quantifiers on a near-miss: exponential in the length of the text.
    const hostile = `${'a'.repeat(40)}b`;
    const { path, ids } = project([hostile]);
    const find = { pattern: '(a+)+$', regex: true, caseSensitive: true };

    const job = startJob('project.replaceApply', {
      projectPath: path,
      find,
      replacement: 'x',
      chosen: [{ segmentId: ids[0]!, updatedAt: await updatedAt(path, ids[0]!) }],
      actor: TEST_ACTOR,
    });
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    job.cancel({ immediately: true });
    const outcome = await job.done;
    expect(outcome).toMatchObject({ status: 'cancelled', terminated: true });
    // Ended at once, not when the expression finished (it would not, in this test's lifetime).
    expect(Date.now() - started).toBeLessThan(2000);

    const db = openProjectDb(path);
    expect(plainText(getSegment(db, ids[0]!)!.targetTokens ?? [])).toBe(hostile);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_event WHERE action = 'project.replaced'",
        )
        .get(),
    ).toEqual({ n: 0 });
    db.close();
  }, 20_000);
});

async function updatedAt(path: string, id: number): Promise<string> {
  const db = openProjectDb(path);
  try {
    return getSegment(db, id)!.updatedAt;
  } finally {
    db.close();
  }
}
