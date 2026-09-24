/**
 * One benchmark size, in its own process (so peak RSS is per size):
 * builds a synthetic `.ctm` through the real write path, then times
 * lookups, concordance, write-back, fuzzy baselines, copy and VACUUM.
 * Prints one JSON object on its last stdout line; progress goes to
 * stderr. Driven by `run.ts` — not meant to be called by hand.
 */

import { copyFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { hashOf, primarySubtag } from '@cat-tool/core';
import type { TmToken } from '@cat-tool/core';
import {
  createTm,
  ensurePrimarySubtagFn,
  importSdltmFrom,
  importTmx,
  retrievePair,
  writeBack,
} from '@cat-tool/db';
import Database from 'better-sqlite3';

import { SDLTM_APPLICATION_ID } from '../sdltm.fixture.ts';

import {
  prng,
  syntheticUnits,
  tmxDocument,
  vocabulary,
  type SyntheticUnit,
} from './corpus.ts';
import {
  fuzzyScore,
  msSince,
  peakRssMiB,
  sample,
  summarize,
  words,
  type Summary,
} from './stats.ts';

const { values } = parseArgs({
  options: {
    size: { type: 'string' },
    dir: { type: 'string' },
    budget: { type: 'string', default: '60' },
    keep: { type: 'boolean', default: false },
    // Real-file mode: import this Trados memory instead of generating one.
    sdltm: { type: 'string' },
    src: { type: 'string', default: 'en' },
    tgt: { type: 'string', default: 'fr' },
  },
});
const SDLTM = values.sdltm;
const SIZE = Number(values.size ?? 0);
const LABEL = SDLTM !== undefined ? 'sdltm' : SIZE.toLocaleString('en');
const DIR = values.dir!;
const BUDGET_MS = Number(values.budget) * 1000;
const CHUNK = 50_000;

const log = (msg: string): void => {
  process.stderr.write(`[${LABEL}] ${msg}\n`);
};

function removeDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
}

function fileSize(path: string): number {
  return statSync(path).size;
}

const ctmPath = join(DIR, `bench-${SDLTM !== undefined ? 'sdltm' : SIZE}.ctm`);
removeDb(ctmPath);

// ---------------------------------------------------------------- build
// importTmx over 50k-unit TMX documents, one transaction each: the real
// write path (parse, normalise, hash, insert, FTS triggers), in slices
// small enough that the TMX string is never the bottleneck. Single-file
// importTmx is timed separately (import-probe.ts).
log('building');
const db = createTm(ctmPath, { name: `bench ${LABEL}`, generator: 'cat-tool/bench' });
const buildStart = process.hrtime.bigint();
const chunkRates: number[] = [];
let sdltmImport: {
  skippedCount: number;
  warningCount: number;
  tucountMismatch: boolean;
  applicationIdShimmed: boolean;
} | null = null;

/**
 * Real `.sdltm` files carry `application_id` 0, and `parseSdltm` still
 * refuses anything but the one sample's value (tm-format-spec.md §8a.3:
 * "the guard rejects every real file"; dropping it is issue #68's job,
 * not this bench's). So for a file that says 0 — and only then — the
 * bench hands the reader a handle whose `PRAGMA application_id` answers
 * with the value the guard wants; every other statement goes to the
 * real, read-only connection. Nothing in the product changes, and the
 * results record that the shim was used. Once #68 lands, this never
 * triggers.
 */
function withTradosApplicationId(h: Database.Database): {
  handle: Database.Database;
  shimmed: boolean;
} {
  if (h.pragma('application_id', { simple: true }) !== 0) {
    return { handle: h, shimmed: false };
  }
  const handle = new Proxy(h, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) =>
          /^\s*PRAGMA\s+application_id\b/i.test(sql)
            ? { get: () => ({ application_id: SDLTM_APPLICATION_ID }), all: () => [] }
            : target.prepare(sql);
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return { handle, shimmed: true };
}

if (SDLTM !== undefined) {
  // The real path, whole: importSdltmFrom parses the entire memory, then
  // writes it as one transaction — so its time and peak RSS *are* the
  // import measurement. Warnings go to stderr only (they can quote the
  // client's data); the results file records their count.
  const source = new Database(SDLTM, { readonly: true, fileMustExist: true });
  try {
    const { handle, shimmed } = withTradosApplicationId(source);
    if (shimmed) log('  application_id is 0 (as in every real file, §8a.3) — shimmed');
    const r = importSdltmFrom(db, handle);
    sdltmImport = {
      skippedCount: r.skippedCount,
      warningCount: r.warnings.length,
      // importSdltm's own check of units read against the memory's
      // declared tucount — issue #68's first "done when".
      tucountMismatch: r.warnings.some((w) => w.includes('tucount')),
      applicationIdShimmed: shimmed,
    };
    for (const w of r.warnings) log(`  warning: ${w}`);
  } finally {
    source.close();
  }
} else {
  let batch: SyntheticUnit[] = [];
  const flush = (): void => {
    const t = process.hrtime.bigint();
    importTmx(db, tmxDocument(batch));
    chunkRates.push(batch.length / (msSince(t) / 1000));
    if (chunkRates.length % 10 === 0) {
      log(`  ${(chunkRates.length * CHUNK).toLocaleString('en')} units`);
    }
    batch = [];
  };
  for (const u of syntheticUnits(SIZE)) {
    batch.push(u);
    if (batch.length === CHUNK) flush();
  }
  if (batch.length > 0) flush();
}
const buildMs = msSince(buildStart);
const buildPeakRss = peakRssMiB();
db.pragma('wal_checkpoint(TRUNCATE)');
const sizeBytes = fileSize(ctmPath);
const tuvCount = (db.prepare('SELECT COUNT(*) AS n FROM tuv').get() as { n: number }).n;
const tuCount = (db.prepare('SELECT COUNT(*) AS n FROM tu').get() as { n: number }).n;

// The stored language tags, resolved from what the import actually
// wrote (a Trados memory says `en-US`, a query may say `en`).
const storedLangs = JSON.parse(
  (db.prepare('SELECT langs FROM tm WHERE id = 1').get() as { langs: string }).langs,
) as string[];
function storedLang(want: string): string {
  const found = storedLangs.find((l) => primarySubtag(l) === primarySubtag(want));
  if (found === undefined) {
    throw new Error(
      `no "${want}" variants in this memory (it has ${storedLangs.join(', ')})`,
    );
  }
  return found;
}
const SRC = storedLang(SDLTM !== undefined ? values.src! : 'en');
const TGT = storedLang(SDLTM !== undefined ? values.tgt! : 'fr');
const maxTuvId = (db.prepare('SELECT MAX(id) AS n FROM tuv').get() as { n: number }).n;
log(`built in ${(buildMs / 1000).toFixed(1)} s, ${(sizeBytes / 2 ** 20).toFixed(0)} MiB`);

// ------------------------------------------------------- query material
const rand = prng(7);

const pickSource = db.prepare<[number, string], { hash: string; plain: string }>(
  'SELECT hash, plain FROM tuv WHERE id = ? AND lang = ?',
);
function randomSources(n: number): Array<{ hash: string; plain: string }> {
  const out: Array<{ hash: string; plain: string }> = [];
  while (out.length < n) {
    const row = pickSource.get(1 + Math.floor(rand() * maxTuvId), SRC);
    if (row) out.push(row);
  }
  return out;
}
const hitSources = randomSources(2000);

/**
 * Word lists for concordance, stopwords and fuzzy perturbation. The
 * synthetic corpus knows its own Zipf ranks; a real memory's are
 * estimated from a sample of its source sentences by document
 * frequency, so "common" and "rare" mean the same thing in both modes.
 */
function wordLists(): {
  common: string[];
  rare: string[];
  stopwords: Set<string>;
  replacements: string[];
} {
  if (SDLTM === undefined) {
    const vocab = vocabulary(1);
    return {
      common: vocab.en.slice(0, 20),
      rare: Array.from({ length: 50 }, () => vocab.en[3000 + Math.floor(rand() * 3000)]!),
      stopwords: new Set(vocab.en.slice(0, 100)),
      replacements: vocab.en.slice(0, 2000),
    };
  }
  const df = new Map<string, number>();
  for (const s of randomSources(20_000)) {
    for (const w of new Set(words(s.plain))) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const byDf = [...df.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
  const once = byDf.filter((w) => df.get(w) === 1 && /^\p{L}{4,}$/u.test(w));
  return {
    common: byDf.slice(0, 20),
    rare: Array.from({ length: 50 }, () => once[Math.floor(rand() * once.length)]!),
    stopwords: new Set(byDf.slice(0, 100)),
    replacements: byDf.slice(0, 2000),
  };
}
const lists = wordLists();
const missHashes = Array.from({ length: 2000 }, (_, i) =>
  hashOf(`Qzxv${i} absent sentence.`),
);
const lookupHash = (i: number): { hash: string; hit: boolean } =>
  i % 2 === 0
    ? { hash: hitSources[(i / 2) % hitSources.length]!.hash, hit: true }
    : { hash: missHashes[((i - 1) / 2) % missHashes.length]!, hit: false };

/** Times a lookup function over interleaved hits and misses. */
function timeLookups(
  lookup: (hash: string) => number,
  opts: { max: number; min: number },
): { hit: Summary; miss: Summary; all: Summary; hitsFound: number } {
  const hit: number[] = [];
  const miss: number[] = [];
  let hitsFound = 0;
  const all = sample(
    (i) => {
      const { hash, hit: isHit } = lookupHash(i);
      const t = process.hrtime.bigint();
      const n = lookup(hash);
      (isHit ? hit : miss).push(msSince(t));
      if (isHit && n > 0) hitsFound++;
    },
    { ...opts, budgetMs: BUDGET_MS },
  );
  return { hit: summarize(hit), miss: summarize(miss), all: summarize(all), hitsFound };
}

/** The SQL a repository function prepares, captured without copying it. */
function capturePlan(run: () => void, params: Record<string, unknown>): string[] {
  const original = db.prepare.bind(db);
  const seen: string[] = [];
  (db as { prepare: unknown }).prepare = (sql: string) => {
    seen.push(sql);
    return original(sql);
  };
  try {
    run();
  } finally {
    (db as { prepare: unknown }).prepare = original;
  }
  return seen.flatMap((sql) =>
    (
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as Array<{ detail: string }>
    ).map((r) => r.detail),
  );
}

// ------------------------------------------------------- exact lookups
log('exact lookups: retrievePair');
const lookupParams = { srcLang: SRC, tgtLang: TGT, srcHash: hitSources[0]!.hash };
const retrievePairPlan = capturePlan(() => retrievePair(db, lookupParams), lookupParams);
const exactCurrent = timeLookups(
  (srcHash) => retrievePair(db, { srcLang: SRC, tgtLang: TGT, srcHash }).length,
  { max: 10_000, min: 20 },
);

// Not a repository change — the index-friendly rewrite as first
// measured, before backlog #19a shipped one: the language set comes
// from tm.langs, so `lang` can be matched by equality and the
// (lang, hash) index seeks instead of scanning. `retrievePair` now
// reads the set from tuv's own index instead (`matchingLangs`,
// db/lang-match.ts); kept as a column so the two stay comparable.
log('exact lookups: index-friendly candidate');
ensurePrimarySubtagFn(db);
const candidateSql = `
  SELECT t.id AS tuv_id, t.tokens AS tokens
  FROM   tuv s
  JOIN   tuv t ON t.tu_id = s.tu_id AND primary_subtag(t.lang) = primary_subtag(@tgtLang)
  JOIN   tu  u ON u.id = s.tu_id AND u.deleted = 0
  WHERE  s.lang IN (SELECT value FROM json_each((SELECT langs FROM tm WHERE id = 1))
                    WHERE primary_subtag(value) = primary_subtag(@srcLang))
    AND  s.hash = @srcHash
  ORDER  BY t.quality DESC, t.updated_at DESC`;
const candidate = db.prepare<typeof lookupParams, { tuv_id: number; tokens: string }>(
  candidateSql,
);
const candidatePlan = (
  db.prepare(`EXPLAIN QUERY PLAN ${candidateSql}`).all(lookupParams) as Array<{
    detail: string;
  }>
).map((r) => r.detail);
const exactCandidate = timeLookups(
  (srcHash) => {
    const rows = candidate.all({ srcLang: SRC, tgtLang: TGT, srcHash });
    for (const r of rows) JSON.parse(r.tokens);
    return rows.length;
  },
  { max: 10_000, min: 10_000 },
);

// ----------------------------------------------------------- concordance
// No repository function for concordance exists yet; this queries
// tuv_fts directly, joined back to tuv for the language filter.
log('concordance');
const concordanceRanked = db.prepare<[string, string]>(
  `SELECT v.id, v.plain FROM tuv_fts f JOIN tuv v ON v.id = f.rowid
   WHERE tuv_fts MATCH ? AND v.lang = ? ORDER BY f.rank LIMIT 50`,
);
const concordanceFirst = db.prepare<[string, string]>(
  `SELECT v.id, v.plain FROM tuv_fts f JOIN tuv v ON v.id = f.rowid
   WHERE tuv_fts MATCH ? AND v.lang = ? LIMIT 50`,
);
const phraseSources = randomSources(200);
const termSets: Record<string, string[]> = {
  common: lists.common.map((w) => `"${w}"`),
  rare: lists.rare.map((w) => `"${w}"`),
  phrase: phraseSources.map((s) => {
    const ws = words(s.plain);
    const at = Math.floor(rand() * Math.max(1, ws.length - 1));
    return `"${ws.slice(at, at + 2).join(' ')}"`;
  }),
};
const concordance: Record<string, { ranked: Summary; first50: Summary }> = {};
for (const [kind, terms] of Object.entries(termSets)) {
  const opts = { max: 200, min: 20, budgetMs: BUDGET_MS / 2 };
  concordance[kind] = {
    ranked: summarize(
      sample((i) => concordanceRanked.all(terms[i % terms.length]!, SRC), opts),
    ),
    first50: summarize(
      sample((i) => concordanceFirst.all(terms[i % terms.length]!, SRC), opts),
    ),
  };
}

// ------------------------------------------------------------ write-back
log('writeBack');
const writeBackMs = summarize(
  sample(
    (i) => {
      const text: TmToken[] = [{ t: 'text', v: `Benchmark confirm ${i} ${rand()}.` }];
      writeBack(db, {
        source: { lang: SRC, tokens: text },
        target: { lang: TGT, tokens: [{ t: 'text', v: `Confirmation ${i}.` }] },
      });
    },
    { max: 300, min: 20, budgetMs: BUDGET_MS },
  ),
);

// ----------------------------------------------------------------- fuzzy
// Throwaway: fuzzy matching is not built (v1-spec.md §4.3). "Naive"
// scores the query against every source variant; "shortlist" asks FTS
// for the 50 best bm25 candidates and scores only those.
log('fuzzy baselines');
const fuzzyQueries = randomSources(40).map((s) => {
  const ws = words(s.plain);
  ws[Math.floor(rand() * ws.length)] =
    lists.replacements[Math.floor(rand() * lists.replacements.length)]!;
  if (ws.length > 4) ws.splice(Math.floor(rand() * ws.length), 1);
  return ws;
});
const allSources = db.prepare<[string], { plain: string }>(
  'SELECT plain FROM tuv WHERE lang = ?',
);
const shortlist = db.prepare<[string, string], { plain: string }>(
  `SELECT v.plain FROM tuv_fts f JOIN tuv v ON v.id = f.rowid
   WHERE tuv_fts MATCH ? AND v.lang = ? ORDER BY f.rank LIMIT 50`,
);
// Scratch row for the scorer; real segments can run to hundreds of words.
const row = new Int32Array(1 << 16);
const naiveBest: number[] = [];
const naiveMs = sample(
  (i) => {
    const q = fuzzyQueries[i]!;
    let best = 0;
    for (const r of allSources.iterate(SRC)) {
      const s = fuzzyScore(q, words(r.plain), row);
      if (s > best) best = s;
    }
    naiveBest[i] = best;
  },
  { max: fuzzyQueries.length, min: 3, budgetMs: BUDGET_MS },
);
function shortlistRun(terms: (q: string[]) => string[]): {
  ms: Summary;
  recall: number;
  scored: number;
} {
  let found = 0;
  const ms = sample(
    (i) => {
      const q = fuzzyQueries[i]!;
      const match = [...new Set(terms(q))].map((w) => `"${w}"`).join(' OR ');
      let best = 0;
      if (match !== '') {
        for (const r of shortlist.iterate(match, SRC)) {
          const s = fuzzyScore(q, words(r.plain), row);
          if (s > best) best = s;
        }
      }
      if (i < naiveBest.length && best >= naiveBest[i]! - 1e-9) found++;
    },
    { max: fuzzyQueries.length, min: fuzzyQueries.length, budgetMs: BUDGET_MS },
  );
  return {
    ms: summarize(ms),
    recall: found / naiveBest.length,
    scored: naiveBest.length,
  };
}
const fuzzy = {
  naive: summarize(naiveMs),
  shortlistAllTerms: shortlistRun((q) => q),
  shortlistNoStopwords: shortlistRun((q) => q.filter((w) => !lists.stopwords.has(w))),
};

// ------------------------------------------------------ ANALYZE effect
log('ANALYZE');
let t = process.hrtime.bigint();
db.exec('ANALYZE');
const analyzeMs = msSince(t);
const retrievePairPlanAnalyzed = capturePlan(
  () => retrievePair(db, lookupParams),
  lookupParams,
);
const exactAnalyzed = timeLookups(
  (srcHash) => retrievePair(db, { srcLang: SRC, tgtLang: TGT, srcHash }).length,
  { max: 10_000, min: 20 },
);

// ---------------------------------------------------- copy and backup
log('copy');
db.pragma('wal_checkpoint(TRUNCATE)');
const copyPath = `${ctmPath}.copy`;
t = process.hrtime.bigint();
copyFileSync(ctmPath, copyPath);
const copyMs = msSince(t);
rmSync(copyPath, { force: true });
t = process.hrtime.bigint();
await db.backup(copyPath);
const backupMs = msSince(t);
rmSync(copyPath, { force: true });

// ---------------------------------------------------------------- VACUUM
log('VACUUM');
const sizeBeforeVacuum = fileSize(ctmPath);
t = process.hrtime.bigint();
db.exec('VACUUM');
const vacuumMs = msSince(t);
db.pragma('wal_checkpoint(TRUNCATE)');
const sizeAfterVacuum = fileSize(ctmPath);

db.close();
if (!values.keep) removeDb(ctmPath);

const result = {
  size: tuCount,
  source: SDLTM !== undefined ? 'sdltm' : 'synthetic',
  langs: [SRC, TGT],
  tuvCount,
  build: {
    method:
      SDLTM !== undefined
        ? 'importSdltm, whole file'
        : `importTmx, ${CHUNK.toLocaleString('en')}-unit slices`,
    sdltmImport,
    ms: buildMs,
    chunkUnits: CHUNK,
    firstChunkUnitsPerSec: chunkRates[0],
    lastChunkUnitsPerSec: chunkRates[chunkRates.length - 1],
    peakRssMiB: buildPeakRss,
  },
  sizeBytes,
  sizeBeforeVacuum,
  sizeAfterVacuum,
  vacuumMs,
  exact: {
    retrievePair: { ...exactCurrent, plan: retrievePairPlan },
    retrievePairAfterAnalyze: {
      ...exactAnalyzed,
      plan: retrievePairPlanAnalyzed,
      analyzeMs,
    },
    candidate: { ...exactCandidate, plan: candidatePlan },
  },
  concordance,
  writeBackMs,
  fuzzy,
  copyMs,
  backupMs,
  peakRssMiB: peakRssMiB(),
};
process.stdout.write(`${JSON.stringify(result)}\n`);
