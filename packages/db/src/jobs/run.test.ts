import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type Database from 'better-sqlite3';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { openProjectDb } from '../project/index.js';
import { importTmxFile } from '../tm/import-tmx.js';
import { createTm, openTm } from '../tm/index.js';
import { mergeTm } from '../tm/merge.js';
import { analyseTierWords } from '../vendor/payable.js';
import type { JobProgress } from './ops.js';
import { JobError, startJob } from './run.js';

let dir: string | undefined;
const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  dir = undefined;
});
const path = (name: string): string =>
  join((dir ??= mkdtempSync(join(tmpdir(), 'cat-jobs-'))), name);

/** An empty `.ctm`, closed, for a job to open by path. */
function newTm(name: string): string {
  const p = path(`${name}.ctm`);
  createTm(p, { name, generator: 'test' }).close();
  return p;
}

/** A TMX of `n` two-language units, written in slices so a big one never sits in memory. */
function writeTmxTo(p: string, n: number, from = 0): void {
  const fd = openSync(p, 'w');
  writeSync(
    fd,
    `<?xml version="1.0" encoding="UTF-8"?>\n<tmx version="1.4"><header srclang="en" adminlang="en" datatype="plaintext" segtype="sentence"/><body>\n`,
  );
  for (let i = from; i < from + n; i += 2000) {
    let slice = '';
    for (let j = i; j < Math.min(i + 2000, from + n); j++) {
      slice += `<tu><tuv xml:lang="en"><seg>Sentence number ${j} of the corpus.</seg></tuv><tuv xml:lang="es"><seg>Frase número ${j} del corpus.</seg></tuv></tu>\n`;
    }
    writeSync(fd, slice);
  }
  writeSync(fd, '</body></tmx>\n');
  closeSync(fd);
}

function writeTmx(name: string, n: number, from = 0): string {
  const p = path(name);
  writeTmxTo(p, n, from);
  return p;
}

const digestOf = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
const count = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const reopen = (p: string): Database.Database => {
  const db = openTm(p);
  open.push(db);
  return db;
};

describe('running an import on a worker thread', () => {
  it('imports the file and reports progress that only moves forward', async () => {
    const tm = newTm('a');
    const src = writeTmx('a.tmx', 5000);
    const seen: JobProgress[] = [];
    const job = startJob(
      'tm.importTmx',
      { tmPath: tm, sourcePath: src, batchSize: 1000 },
      {
        onProgress: (p) => seen.push(p),
      },
    );
    const outcome = await job.done;
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.value).toMatchObject({
      complete: true,
      tuCount: 5000,
      tuvCount: 10000,
    });

    const fractions = seen.map((p) => p.fraction ?? -1);
    expect(fractions.length).toBeGreaterThanOrEqual(5);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(seen.map((p) => p.units ?? 0)).toEqual(
      [...seen.map((p) => p.units ?? 0)].sort((a, b) => a - b),
    );
    expect(job.progress()).toEqual(seen[seen.length - 1]);

    const db = reopen(tm);
    expect(count(db, 'tu')).toBe(5000);
    expect(count(db, 'tuv')).toBe(10000);
  }, 60_000);

  it('keeps the calling thread free: its timer ticks through the import, and does not inline', async () => {
    const tm = newTm('worker');
    const src = writeTmx('big.tmx', 40_000);

    /** The longest gap between ticks of a 10 ms timer while `work` runs. */
    async function longestGap(work: () => Promise<unknown>): Promise<number> {
      let last = performance.now();
      let longest = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
      }, 10);
      try {
        await work();
      } finally {
        // A thread blocked for the whole of `work` never ticked at all: the
        // time since the last tick is the gap, and is what the control shows.
        longest = Math.max(longest, performance.now() - last);
        clearInterval(timer);
      }
      return longest;
    }

    const off = await longestGap(async () => {
      expect(
        (await startJob('tm.importTmx', { tmPath: tm, sourcePath: src }).done).status,
      ).toBe('done');
    });

    // The control: the same import on this thread blocks it for the whole import.
    const inlineTm = path('inline.ctm');
    const inline = await longestGap(async () => {
      await Promise.resolve();
      const db = createTm(inlineTm, { name: 'inline', generator: 'test' });
      open.push(db);
      importTmxFile(db, src);
    });

    expect(inline, 'the control must block, or this test proves nothing').toBeGreaterThan(
      500,
    );
    // Relative to the control, and capped: a starved CI runner stretches both, and
    // what the test claims is that the worker's gap is nowhere near blocking.
    expect(off).toBeLessThan(Math.min(1000, inline / 3));
  }, 300_000);

  it('rejects with the error that stopped it, by class name', async () => {
    const tm = newTm('bad');
    const src = path('broken.tmx');
    const fd = openSync(src, 'w');
    writeSync(fd, '<tmx><body><tu>');
    closeSync(fd);
    const err = await startJob('tm.importTmx', {
      tmPath: tm,
      sourcePath: src,
    }).done.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobError);
    expect((err as JobError).causeName).toBe('TmxError');
  }, 60_000);

  it('cancels at a batch boundary: whole batches stay, the import is incomplete, and resume finishes it', async () => {
    const tm = newTm('c');
    const src = writeTmx('c.tmx', 20_000);
    const batch = 500;
    const job: ReturnType<typeof startJob<'tm.importTmx'>> = startJob(
      'tm.importTmx',
      { tmPath: tm, sourcePath: src, batchSize: batch },
      {
        graceMs: 60_000, // cooperative only: the terminate must not be what ends it
        onProgress: (p) => {
          if ((p.units ?? 0) > 0) job.cancel();
        },
      },
    );
    const outcome = await job.done;
    expect(outcome.status).toBe('cancelled');
    if (outcome.status !== 'cancelled') return;
    expect(outcome.terminated).toBe(false);
    expect(outcome.value?.complete).toBe(false);

    const db = reopen(tm);
    const [run] = db.prepare('SELECT * FROM tm_import').all() as Array<{
      id: number;
      finished_at: string | null;
      units_done: number;
    }>;
    expect(run!.finished_at).toBeNull(); // visible, not hidden
    const units = count(db, 'tu');
    expect(units).toBeGreaterThan(0);
    expect(units).toBeLessThan(20_000);
    expect(units).toBe(run!.units_done);
    expect(units % batch).toBe(0); // whole batches only
    expect(count(db, 'tuv')).toBe(units * 2); // and no unit without its variants
    db.close();

    const resumed = await startJob('tm.importTmx', {
      tmPath: tm,
      sourcePath: src,
      batchSize: batch,
      resume: run!.id,
    }).done;
    expect(resumed.status).toBe('done');
    const after = reopen(tm);
    expect(count(after, 'tu')).toBe(20_000);
    expect(count(after, 'tuv')).toBe(40_000);
    expect(
      (after.prepare('SELECT COUNT(DISTINCT uuid) AS n FROM tu').get() as { n: number })
        .n,
    ).toBe(20_000);
  }, 300_000);

  it('cancelling after it ended, or twice, does nothing', async () => {
    const tm = newTm('d');
    const src = writeTmx('d.tmx', 100);
    const job = startJob('tm.importTmx', { tmPath: tm, sourcePath: src });
    expect((await job.done).status).toBe('done');
    job.cancel();
    job.cancel();
    expect((await job.done).status).toBe('done');
  }, 60_000);
});

describe('cancelling an operation that cannot stop itself', () => {
  const SOURCE_UNITS = 60_000;
  let shared: string | undefined;
  /** Built once: a 200-unit destination and a source big enough that a merge takes a while. */
  function sharedPair(): { dest: string; src: string } {
    if (!shared) {
      shared = mkdtempSync(join(tmpdir(), 'cat-jobs-shared-'));
      for (const [name, units, from] of [
        ['dest', 200, 0],
        ['src', SOURCE_UNITS, 1_000_000],
      ] as const) {
        const p = join(shared, `${name}.ctm`);
        createTm(p, { name, generator: 'test' }).close();
        const tmx = join(shared, `${name}.tmx`);
        writeTmxTo(tmx, units, from);
        const db = openTm(p);
        importTmxFile(db, tmx);
        db.close();
      }
    }
    return { dest: join(shared, 'dest.ctm'), src: join(shared, 'src.ctm') };
  }
  afterAll(() => {
    if (shared) rmSync(shared, { recursive: true, force: true, maxRetries: 3 });
  });
  /** A fresh copy of the destination, which a test may merge into or kill. */
  function pair(): { dest: string; src: string } {
    const { dest, src } = sharedPair();
    const copy = path('dest-copy.ctm');
    copyFileSync(dest, copy);
    return { dest: copy, src };
  }

  const snapshot = (p: string) => {
    const db = openTm(p);
    try {
      return {
        units: count(db, 'tu'),
        variants: count(db, 'tuv'),
        history: count(db, 'tuv_history'),
        langs: (db.prepare('SELECT langs FROM tm').get() as { langs: string }).langs,
        integrity: db.pragma('integrity_check', { simple: true }),
        content: db
          .prepare(
            'SELECT group_concat(uuid || rev || updated_at) AS c FROM (SELECT * FROM tu ORDER BY uuid)',
          )
          .get(),
      };
    } finally {
      db.close();
    }
  };

  it('terminating a merge in the middle of its transaction leaves the destination exactly as it was', async () => {
    const { dest, src } = pair();
    const before = snapshot(dest);
    const job: ReturnType<typeof startJob<'tm.merge'>> = startJob(
      'tm.merge',
      { tmPath: dest, sourcePath: src, actor: TEST_ACTOR },
      {
        graceMs: 0, // terminate at once, not wait for the next phase boundary
        onProgress: (p) => {
          // By here the earlier phases have written inside the open transaction.
          if (p.stage === 'copying new variants') job.cancel();
        },
      },
    );
    const outcome = await job.done;
    expect(outcome.status).toBe('cancelled');
    // killed in the middle of a statement, not stopped at a phase boundary
    if (outcome.status === 'cancelled') expect(outcome.terminated).toBe(true);
    expect(snapshot(dest)).toEqual(before);
    expect(before.units).toBe(200);

    // and the same merge, left alone, does run to completion afterwards
    const again = await startJob('tm.merge', {
      tmPath: dest,
      sourcePath: src,
      actor: TEST_ACTOR,
    }).done;
    expect(again.status).toBe('done');
    expect(snapshot(dest).units).toBe(200 + SOURCE_UNITS);
  }, 180_000);

  it('a cooperative stop between phases rolls the merge back too', async () => {
    const { dest, src } = pair();
    const before = snapshot(dest);
    const job: ReturnType<typeof startJob<'tm.merge'>> = startJob(
      'tm.merge',
      { tmPath: dest, sourcePath: src, actor: TEST_ACTOR },
      {
        graceMs: 60_000,
        onProgress: (p) => {
          if (p.stage === 'merging unit attributes') job.cancel();
        },
      },
    );
    const outcome = await job.done;
    expect(outcome.status).toBe('cancelled');
    if (outcome.status === 'cancelled') expect(outcome.terminated).toBe(false);
    expect(snapshot(dest)).toEqual(before);
  }, 180_000);
});

describe('the other operations', () => {
  it('a merge through the worker gives what mergeTm gives, and reports its phases', async () => {
    const [a1, b] = [newTm('a1'), newTm('b')];
    const a2 = path('a2.ctm');
    for (const [p, tmx] of [
      [a1, writeTmx('x.tmx', 300, 0)],
      [b, writeTmx('y.tmx', 300, 150)],
    ] as const) {
      const db = openTm(p);
      importTmxFile(db, tmx);
      db.close();
    }
    const copy = openTm(a1);
    copy.close();
    // the same destination twice: one merged inline, one through the worker
    copyFileSync(a1, a2);

    const inline = openTm(a1);
    const expected = mergeTm(inline, b, { actor: TEST_ACTOR });
    inline.close();

    const stages: string[] = [];
    const outcome = await startJob(
      'tm.merge',
      { tmPath: a2, sourcePath: b, actor: TEST_ACTOR },
      {
        onProgress: (p) => stages.push(p.stage),
      },
    ).done;
    expect(outcome).toEqual({ status: 'done', value: expected });
    expect(stages).toHaveLength(10);
    expect(stages[0]).toBe('matching units');
  }, 30_000);

  it('vacuums, after taking a backup of the whole memory (§10)', async () => {
    const tm = newTm('v');
    const src = writeTmx('v.tmx', 500);
    const db = openTm(tm);
    importTmxFile(db, src);
    db.exec('DELETE FROM tu WHERE id % 2 = 0'); // room for compaction to find
    db.close();
    const before = readFileSync(tm);

    const outcome = await startJob('tm.vacuum', { tmPath: tm }).done;
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.value.bytesAfter).toBeGreaterThan(0);
    expect(outcome.value.bytesAfter).toBeLessThan(outcome.value.bytesBefore);
    expect(outcome.value.backup).toMatch(/^v\.ctm\.bak-vacuum-/);

    // The backup is the memory as it was, byte for byte, and opens as a memory.
    const backup = join(dirname(tm), outcome.value.backup);
    expect(digestOf(readFileSync(backup))).toBe(digestOf(before));
    const restored = reopen(backup);
    expect(count(restored, 'tu')).toBe(250);
  }, 60_000);

  it('describes the memory it imported while it still has it open', async () => {
    const tm = newTm('s');
    const outcome = await startJob('tm.importTmx', {
      tmPath: tm,
      sourcePath: writeTmx('s.tmx', 1234),
    }).done;
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.value.summary).toMatchObject({ name: 's', units: 1234 });
    expect([...outcome.value.summary.langs].sort()).toEqual(['en', 'es']);
  }, 60_000);
});

describe('project.analyseTiers', () => {
  it("returns a project's words by tier, the same as the function run in place", async () => {
    const projectPath = path('project.catdb');
    openProjectDb(projectPath).close();
    const outcome = await startJob('project.analyseTiers', { projectPath }).done;
    expect(outcome.status).toBe('done');
    const reopened = openProjectDb(projectPath);
    open.push(reopened);
    expect(outcome.status === 'done' && outcome.value).toEqual(
      analyseTierWords(reopened),
    );
  });
});
