/**
 * Single-file `importTmx` probe, in its own process so peak RSS is the
 * import's alone: read one TMX file whole (importTmx takes a string),
 * import it into a fresh `.ctm`, report time and peak RSS as one JSON
 * line. A failure is a result, not a crash — at some size the string or
 * the heap runs out, and where that happens is what this measures.
 */

import { readFileSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { createTm, importTmx } from '@cat-tool/db';

import { msSince, peakRssMiB } from './stats.ts';

const { values } = parseArgs({
  options: { tmx: { type: 'string' }, ctm: { type: 'string' } },
});
const tmxPath = values.tmx!;
const ctmPath = values.ctm!;

const began = process.hrtime.bigint();
let stage = 'read';
try {
  const xml = readFileSync(tmxPath, 'utf8');
  const readMs = msSince(began);
  stage = 'import';
  const db = createTm(ctmPath, { name: 'probe', generator: 'cat-tool/bench' });
  const result = importTmx(db, xml);
  db.close();
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      readMs,
      totalMs: msSince(began),
      tuCount: result.tuCount,
      peakRssMiB: peakRssMiB(),
    })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      stage,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      totalMs: msSince(began),
      peakRssMiB: peakRssMiB(),
    })}\n`,
  );
} finally {
  for (const suffix of ['', '-wal', '-shm']) rmSync(ctmPath + suffix, { force: true });
}
