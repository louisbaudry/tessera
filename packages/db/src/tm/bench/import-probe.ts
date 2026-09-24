/**
 * Single-file TMX import probe, in its own process so peak RSS is the
 * import's alone: stream one TMX file through `importTmxFile` (backlog
 * #18c) into a fresh `.ctm`, report time and peak RSS as one JSON line.
 * `run.ts` starts it under a V8 heap cap (`--probe-heap-mib`, default
 * 2048: a 2 GB server), so "it fits" is enforced rather than inferred.
 * A failure is a result, not a crash — if the heap runs out, where it
 * happens is what this measures.
 *
 * Before #18c this read the file whole into one string for `importTmx`:
 * 4.1 GiB peak RSS at 1M units, and at 5M a string V8 cannot make
 * (tm-format-spec.md §11.1).
 */

import { rmSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { parseArgs } from 'node:util';

import { createTm, importTmxFile } from '@cat-tool/db';

import { msSince, peakRssMiB } from './stats.ts';

const { values } = parseArgs({
  options: { tmx: { type: 'string' }, ctm: { type: 'string' } },
});
const tmxPath = values.tmx!;
const ctmPath = values.ctm!;

const began = process.hrtime.bigint();
const heapLimitMiB = Math.round(getHeapStatistics().heap_size_limit / 2 ** 20);
const stage = 'import';
try {
  const db = createTm(ctmPath, { name: 'probe', generator: 'cat-tool/bench' });
  const result = importTmxFile(db, tmxPath);
  db.close();
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      totalMs: msSince(began),
      tuCount: result.tuCount,
      heapLimitMiB,
      peakRssMiB: peakRssMiB(),
    })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      stage,
      heapLimitMiB,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      totalMs: msSince(began),
      peakRssMiB: peakRssMiB(),
    })}\n`,
  );
} finally {
  for (const suffix of ['', '-wal', '-shm']) rmSync(ctmPath + suffix, { force: true });
}
