/**
 * `.ctm` scale benchmark (tm-format-spec.md §11) — `pnpm bench:tm`.
 *
 * For each size: generate a synthetic TMX file and import it whole
 * (import-probe.ts), then build a `.ctm` of that size and measure it
 * (measure.ts). Each runs in its own child process so peak RSS belongs
 * to one size and one operation. Everything generated goes under
 * `--dir` (default: the OS temp dir) and is deleted as it goes; nothing
 * here is ever committed.
 *
 * Synthetic data: read §11 before quoting a number from this.
 *
 *   pnpm bench:tm                                  # 100k, 1M, 5M
 *   pnpm bench:tm --sizes 100000 --budget 20       # quick pass
 *   pnpm bench:tm --sizes 5000000 --probe-only     # the import alone (#18c)
 *   pnpm bench:tm --sdltm ~/client.sdltm --src en --tgt es
 *
 * `--sdltm` measures a real Trados memory instead of synthetic sizes:
 * it is imported whole through `importSdltm` (read-only on the original)
 * into a `.ctm` under `--dir`, measured, then deleted. The results
 * files hold timings, counts and query plans only — no text from the
 * memory — but read them before sharing; import warnings print to the
 * terminal, never to the results.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';

import { writeTmxFile } from './corpus.ts';
import { msSince } from './stats.ts';
import { markdownTables, type BenchResults } from './table.ts';

const { values } = parseArgs({
  options: {
    sizes: { type: 'string', default: '100000,1000000,5000000' },
    dir: { type: 'string', default: join(tmpdir(), 'cat-tool-tm-bench') },
    budget: { type: 'string', default: '60' },
    'probe-max': { type: 'string', default: '5000000' },
    // The import probe's V8 heap cap: 2048 MiB is a 2 GB server (#18c).
    'probe-heap-mib': { type: 'string', default: '2048' },
    // Import probe only: skip the hour-long, 7.5 GiB-at-5M measure step.
    'probe-only': { type: 'boolean', default: false },
    sdltm: { type: 'string' },
    src: { type: 'string', default: 'en' },
    tgt: { type: 'string' },
  },
  // `pnpm run x -- args` forwards the `--` itself (CLAUDE.md).
  args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--')),
});

const here = dirname(fileURLToPath(import.meta.url));
const sizes = values.sizes.split(',').map(Number);
const dir = values.dir;
mkdirSync(dir, { recursive: true });

function child(script: string, args: string[], nodeArgs: string[] = []): unknown {
  const r = spawnSync(
    process.execPath,
    [...process.execArgv, ...nodeArgs, join(here, script), ...args],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 2 ** 20,
      encoding: 'utf8',
    },
  );
  const last = r.stdout.trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(last);
  } catch {
    return {
      ok: false,
      error: `exit ${r.status ?? r.signal}`,
      stdout: last.slice(0, 500),
    };
  }
}

const probe = new Database(':memory:');
const machine = {
  cpu: cpus()[0]?.model ?? 'unknown',
  cores: cpus().length,
  memGiB: +(totalmem() / 2 ** 30).toFixed(1),
  freeMemGiB: +(freemem() / 2 ** 30).toFixed(1),
  os: `${platform()} ${release()}`,
  node: process.version,
  sqlite: (probe.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
};
probe.close();
process.stderr.write(`${JSON.stringify(machine)}\n`);

const results: unknown[] = [];
if (values.sdltm !== undefined) {
  if (values.tgt === undefined)
    throw new Error('--sdltm needs --tgt (and --src, default en)');
  const sdltmBytes = statSync(values.sdltm).size;
  const measured = child('measure.ts', [
    '--sdltm',
    values.sdltm,
    '--src',
    values.src,
    '--tgt',
    values.tgt,
    '--dir',
    dir,
    '--budget',
    values.budget,
  ]);
  results.push({ size: 0, sdltmBytes, importProbe: null, measured });
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ machine, results }, null, 2));
}
for (const size of values.sdltm !== undefined ? [] : sizes) {
  let importProbe: unknown = null;
  if (size <= Number(values['probe-max'])) {
    const tmxPath = join(dir, `bench-${size}.tmx`);
    process.stderr.write(`[${size.toLocaleString('en')}] writing TMX\n`);
    const t = process.hrtime.bigint();
    writeTmxFile(tmxPath, size);
    const tmxBytes = statSync(tmxPath).size;
    const tmxWriteMs = msSince(t);
    process.stderr.write(`[${size.toLocaleString('en')}] streaming importTmxFile\n`);
    importProbe = {
      tmxBytes,
      tmxWriteMs,
      ...(child(
        'import-probe.ts',
        ['--tmx', tmxPath, '--ctm', join(dir, `bench-${size}.probe.ctm`)],
        [`--max-old-space-size=${values['probe-heap-mib']}`],
      ) as object),
    };
    rmSync(tmxPath, { force: true });
  }
  if (values['probe-only']) {
    results.push({
      size,
      importProbe,
      measured: { ok: false, error: 'not run (--probe-only)' },
    });
    writeFileSync(
      join(dir, 'results.json'),
      JSON.stringify({ machine, results }, null, 2),
    );
    continue;
  }
  const measured = child('measure.ts', [
    '--size',
    String(size),
    '--dir',
    dir,
    '--budget',
    values.budget,
  ]);
  results.push({ size, importProbe, measured });
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ machine, results }, null, 2));
}

const tables = markdownTables({ machine, results } as BenchResults);
writeFileSync(join(dir, 'results.md'), `${tables}\n`);
process.stdout.write(`${tables}\n`);
process.stderr.write(`results written to ${join(dir, 'results.{json,md}')}\n`);
