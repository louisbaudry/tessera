/**
 * E-001, offline shortlist recall — `pnpm bench:e001`.
 *
 * The setup this implements is fixed in
 * research/semantic-matching/experiments/E-001-shortlist-recall.md,
 * committed before the first run; read it before changing anything
 * here, and never change what it fixed without a journal entry.
 *
 * One corpus per invocation. Builds a `.ctm` through the real import
 * path (or reuses one with --reuse), draws the query sets, runs the
 * model-free arms (naive, fts50, ftsK), then for each model embeds the
 * memory into `tuv_vec` and runs the vector arms (union, vecOnly).
 * Writes one results file per model plus one with `model: null`.
 *
 *   pnpm bench:e001 --corpus synthetic --size 100000
 *   pnpm bench:e001 --corpus moses --src-file DGT.en-fr.en --tgt-file DGT.en-fr.fr \
 *       --corpus-file en-fr.txt.zip --corpus-id dgt-tm-v2019-en-fr-1M --max-units 1000000
 *   pnpm bench:e001 --corpus sdltm --sdltm ~/client.sdltm --corpus-id private-A \
 *       --src en --tgt es --out ~/e001-private
 *
 * Results hold numbers only. The query texts, which for a private
 * memory are client text, stay in a sidecar next to the `.ctm` under
 * --dir, never under --out.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { primarySubtag } from '@cat-tool/core';
import type { Embedder, EmbeddingModel } from '@cat-tool/core';
import {
  createTm,
  importSdltmFrom,
  importTmx,
  loadVectors,
  openTm,
  topByDot,
  unembeddedVariants,
  writeVectors,
  type VectorSet,
} from '@cat-tool/db';
import Database from 'better-sqlite3';
import hnswlib from 'hnswlib-node';

import { prng, syntheticUnits, tmxDocument, type SyntheticUnit } from './corpus.ts';
import { transformersEmbedder } from './embedder.ts';
import { E001_MODELS, type E001ModelKey } from './models.ts';
import { withTradosApplicationId } from './sdltm-shim.ts';
import {
  fuzzyScore,
  mcnemarOneSided,
  msSince,
  peakRssMiB,
  summarize,
  words,
} from './stats.ts';
import { wordLists } from './words.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../..');

const { values } = parseArgs({
  options: {
    corpus: { type: 'string' },
    size: { type: 'string' },
    'src-file': { type: 'string' },
    'tgt-file': { type: 'string' },
    'corpus-file': { type: 'string' },
    'corpus-id': { type: 'string' },
    'max-units': { type: 'string' },
    sdltm: { type: 'string' },
    src: { type: 'string', default: 'en' },
    tgt: { type: 'string', default: 'fr' },
    models: { type: 'string', default: 'e5s,minilm,labse' },
    m: { type: 'string', default: '10,25,50' },
    lex: { type: 'string', default: '400' },
    para: { type: 'string', default: '400' },
    'budget-ms': { type: 'string', default: '100' },
    dir: { type: 'string', default: join(tmpdir(), 'cat-tool-e001') },
    out: {
      type: 'string',
      default: join(repoRoot, 'research/semantic-matching/results/E-001'),
    },
    'model-cache': { type: 'string', default: join(tmpdir(), 'cat-tool-models') },
    reuse: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    exploratory: { type: 'boolean', default: false },
    // `exact`, the reference; `hnsw` only where exact misses the budget
    // (E-001, "Vector search").
    search: { type: 'string', default: 'exact' },
    notes: { type: 'string', default: '' },
  },
  // `pnpm run x -- args` forwards the `--` itself (CLAUDE.md).
  args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--')),
});

const CORPUS = values.corpus as 'synthetic' | 'moses' | 'sdltm' | undefined;
if (CORPUS !== 'synthetic' && CORPUS !== 'moses' && CORPUS !== 'sdltm') {
  throw new Error('--corpus must be synthetic, moses or sdltm');
}
const SIZE = Number(values.size ?? 0);
const CORPUS_ID =
  values['corpus-id'] ?? (CORPUS === 'synthetic' ? syntheticId(SIZE) : undefined);
if (CORPUS_ID === undefined) throw new Error('--corpus-id is required for this corpus');
const M_VALUES = values.m.split(',').map(Number);
const SEARCH = values.search as 'exact' | 'hnsw';
if (SEARCH !== 'exact' && SEARCH !== 'hnsw')
  throw new Error('--search must be exact or hnsw');
// E-001's fixed HNSW parameters.
const HNSW = { M: 16, efConstruction: 200, efSearch: 128, seed: 100 } as const;
const MODEL_KEYS = values.models.split(',') as E001ModelKey[];
for (const k of MODEL_KEYS) {
  if (!(k in E001_MODELS)) throw new Error(`unknown model "${k}"`);
}
const LEX_N = Number(values.lex);
const PARA_N = CORPUS === 'synthetic' ? 0 : Number(values.para);
const BUDGET_MS = Number(values['budget-ms']);
const FTS_K = 50;
const SEED = 7;
const TMX_CHUNK = 50_000;
const EMBED_CHUNK = 2048;
const DIR = values.dir;
const OUT = values.out;
mkdirSync(DIR, { recursive: true });
mkdirSync(OUT, { recursive: true });

function syntheticId(size: number): string {
  return size % 1_000_000 === 0
    ? `synthetic-${size / 1_000_000}M`
    : `synthetic-${size / 1000}k`;
}

const log = (msg: string): void => {
  process.stderr.write(`[${CORPUS_ID}] ${msg}\n`);
};

// ------------------------------------------------------------ provenance
const startedAt = new Date().toISOString();
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
// Results written by this very run must not make the next file "dirty".
const dirty =
  git('status', '--porcelain', '--', '.', ':!research/semantic-matching/results') !== '';

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}
function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const corpusSha256 =
  CORPUS === 'synthetic'
    ? // Generated, so the generator is the corpus: its source plus the size.
      sha256Json({ corpus: readFileSync(join(here, 'corpus.ts'), 'utf8'), size: SIZE })
    : await sha256File(CORPUS === 'sdltm' ? values.sdltm! : values['corpus-file']!);

const probe = new Database(':memory:');
const machine = {
  cpu: cpus()[0]?.model ?? 'unknown',
  cores: cpus().length,
  ram_gib: +(totalmem() / 2 ** 30).toFixed(1),
  os: `${platform()} ${release()}`,
  node: process.version,
  sqlite: (probe.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
};
probe.close();

// ----------------------------------------------------------------- build
const ctmPath = join(DIR, `e001-${CORPUS_ID}.ctm`);
const sidecarPath = `${ctmPath}.queries.json`;

interface ParaPair {
  /** The held-out source, whose every unit was removed from the memory. */
  readonly query: string;
  /** `tuv.id` of B's source variant, which stays. */
  readonly partner: number;
}
interface Sidecar {
  readonly corpusSha256: string;
  readonly paraEligible: number;
  readonly para: ParaPair[];
  readonly units: number;
}

function removeDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
}

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function buildMoses(db: Database.Database): Promise<void> {
  const max = Number(values['max-units'] ?? Infinity);
  const src = createInterface({ input: createReadStream(values['src-file']!) });
  const tgt = createInterface({ input: createReadStream(values['tgt-file']!) })[
    Symbol.asyncIterator
  ]();
  const head =
    '<?xml version="1.0" encoding="UTF-8"?>\n<tmx version="1.4">\n' +
    `<header creationtool="cat-tool-e001" creationtoolversion="1" srclang="${values.src}" ` +
    'adminlang="en" datatype="plaintext" o-tmf="moses" segtype="sentence"/>\n<body>\n';
  let lines = 0;
  let batch: string[] = [];
  const flush = (): void => {
    importTmx(db, `${head}${batch.join('')}</body>\n</tmx>\n`);
    batch = [];
  };
  for await (const s of src) {
    const t = await tgt.next();
    if (t.done) throw new Error('target file is shorter than the source file');
    if (lines++ >= max) break;
    // Pre-registered: empty sides dropped.
    if (s.trim() === '' || t.value.trim() === '') continue;
    batch.push(
      `<tu><tuv xml:lang="${values.src}"><seg>${xml(s)}</seg></tuv>` +
        `<tuv xml:lang="${values.tgt}"><seg>${xml(t.value)}</seg></tuv></tu>\n`,
    );
    if (batch.length === TMX_CHUNK) {
      flush();
      if ((lines / TMX_CHUNK) % 10 === 0) log(`  ${lines.toLocaleString('en')} lines`);
    }
  }
  src.close();
  if (batch.length > 0) flush();
}

function buildSynthetic(db: Database.Database): void {
  let batch: SyntheticUnit[] = [];
  for (const u of syntheticUnits(SIZE)) {
    batch.push(u);
    if (batch.length === TMX_CHUNK) {
      importTmx(db, tmxDocument(batch));
      batch = [];
    }
  }
  if (batch.length > 0) importTmx(db, tmxDocument(batch));
}

function buildSdltm(db: Database.Database): void {
  const source = new Database(values.sdltm!, { readonly: true, fileMustExist: true });
  try {
    const { handle } = withTradosApplicationId(source);
    // Warnings can quote the client's data: counted, never printed.
    const r = importSdltmFrom(db, handle);
    log(`  imported, ${r.warnings.length} warnings (not shown)`);
  } finally {
    source.close();
  }
}

function storedLang(db: Database.Database, want: string): string {
  const langs = JSON.parse(
    (db.prepare('SELECT langs FROM tm WHERE id = 1').get() as { langs: string }).langs,
  ) as string[];
  const found = langs.find((l) => primarySubtag(l) === primarySubtag(want));
  if (found === undefined) throw new Error(`no "${want}" variants in this memory`);
  return found;
}

/**
 * The `para` query set (E-001, "Query sets"): units sharing an
 * identical target, sources below the fuzzy threshold of each other.
 * Every unit carrying a chosen query's source is then deleted, so the
 * query has no exact match and its partner is what remains.
 */
function drawPara(
  db: Database.Database,
  SRC: string,
  TGT: string,
  rand: () => number,
): { eligible: number; pairs: ParaPair[] } {
  const rows = db
    .prepare<[string, string, string], { tplain: string; sid: number; splain: string }>(
      `SELECT t.plain AS tplain, s.id AS sid, s.plain AS splain
       FROM   tuv t
       JOIN   tuv s ON s.tu_id = t.tu_id AND s.lang = ?
       WHERE  t.lang = ?
         AND  t.plain IN (SELECT plain FROM tuv WHERE lang = ?
                          GROUP BY plain HAVING COUNT(*) > 1)
       ORDER  BY t.plain, s.id`,
    )
    .all(SRC, TGT, TGT);
  const groups = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (words(r.tplain).length < 4) continue;
    let g = groups.get(r.tplain);
    if (!g) groups.set(r.tplain, (g = new Map()));
    if (!g.has(r.splain) && words(r.splain).length > 0) g.set(r.splain, r.sid);
  }
  const row = new Int32Array(1 << 16);
  const eligible: Array<[string, number]> = [];
  for (const g of groups.values()) {
    if (g.size < 2) continue;
    const sources = [...g.entries()];
    // Seeded order within the group, then the first qualifying pair.
    for (let i = sources.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [sources[i], sources[j]] = [sources[j]!, sources[i]!];
    }
    search: for (let a = 0; a < sources.length; a++) {
      for (let b = 0; b < sources.length; b++) {
        if (a === b) continue;
        const [qa] = sources[a]!;
        const [qb, sidB] = sources[b]!;
        if (fuzzyScore(words(qa), words(qb), row) < 0.75) {
          eligible.push([qa, sidB]);
          break search;
        }
      }
    }
  }
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j]!, eligible[i]!];
  }
  // Keep drawing in the shuffled order until PARA_N are kept. A pair is
  // skipped when its partner is already gone, or when deleting its
  // query's units would take a kept pair's partner with them.
  const kept = new Set<number>();
  const used = new Set<string>();
  const hits = db.prepare<[string, string], { id: number }>(
    'SELECT id FROM tuv WHERE lang = ? AND plain = ?',
  );
  const exists = db.prepare<[number], { id: number }>('SELECT id FROM tuv WHERE id = ?');
  const del = db.prepare(
    `DELETE FROM tu WHERE id IN (SELECT tu_id FROM tuv WHERE lang = ? AND plain = ?)`,
  );
  const pairs: ParaPair[] = [];
  db.transaction(() => {
    for (const [query, partner] of eligible) {
      if (pairs.length === PARA_N) break;
      if (used.has(query) || exists.get(partner) === undefined) continue;
      if (hits.all(SRC, query).some((h) => kept.has(h.id))) continue;
      del.run(SRC, query);
      used.add(query);
      kept.add(partner);
      pairs.push({ query, partner });
    }
  })();
  return { eligible: eligible.length, pairs };
}

let db: Database.Database;
let sidecar: Sidecar;
const buildStart = process.hrtime.bigint();
if (values.reuse && existsSync(ctmPath) && existsSync(sidecarPath)) {
  db = openTm(ctmPath);
  sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Sidecar;
  if (sidecar.corpusSha256 !== corpusSha256) {
    throw new Error('--reuse: the kept .ctm was built from a different corpus');
  }
  log('reusing the kept .ctm');
} else {
  removeDb(ctmPath);
  log('building');
  db = createTm(ctmPath, { name: `e001 ${CORPUS_ID}`, generator: 'cat-tool/e001' });
  if (CORPUS === 'synthetic') buildSynthetic(db);
  else if (CORPUS === 'moses') await buildMoses(db);
  else buildSdltm(db);
  const S = storedLang(db, CORPUS === 'synthetic' ? 'en' : values.src);
  const T = storedLang(db, CORPUS === 'synthetic' ? 'fr' : values.tgt);
  const para = PARA_N > 0 ? drawPara(db, S, T, prng(SEED)) : { eligible: 0, pairs: [] };
  const units = (db.prepare('SELECT COUNT(*) AS n FROM tu').get() as { n: number }).n;
  sidecar = { corpusSha256, paraEligible: para.eligible, para: para.pairs, units };
  writeFileSync(sidecarPath, JSON.stringify(sidecar));
  log(`built in ${(msSince(buildStart) / 1000).toFixed(0)} s, ${units} units`);
}
db.pragma('wal_checkpoint(TRUNCATE)');
const SRC = storedLang(db, CORPUS === 'synthetic' ? 'en' : values.src);
const TGT = storedLang(db, CORPUS === 'synthetic' ? 'fr' : values.tgt);

// --------------------------------------------------------- query material
const rand = prng(SEED);
const maxTuvId = (db.prepare('SELECT MAX(id) AS n FROM tuv').get() as { n: number }).n;
const pickSource = db.prepare<[number, string], { id: number; plain: string }>(
  'SELECT id, plain FROM tuv WHERE id = ? AND lang = ?',
);
function randomSources(n: number): Array<{ id: number; plain: string }> {
  const out: Array<{ id: number; plain: string }> = [];
  while (out.length < n) {
    const r = pickSource.get(1 + Math.floor(rand() * maxTuvId), SRC);
    if (r && words(r.plain).length > 0) out.push(r);
  }
  return out;
}
const lists = wordLists({
  synthetic: CORPUS === 'synthetic',
  rand,
  sampleSources: randomSources,
});

interface Query {
  /** What is embedded: natural text. */
  readonly text: string;
  /** What FS-1 and FTS see. */
  readonly words: string[];
  /** For `para`: the partner's source `tuv.id`. */
  readonly partner?: number;
}

/**
 * E-000's perturbation — one word replaced, one deleted if longer than
 * four — applied to the text's word spans, so FS-1 sees exactly E-000's
 * word list and the embedder still sees punctuation and case.
 */
function perturb(plain: string): Query {
  const spans = [...plain.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    at: m.index,
    len: m[0].length,
    text: m[0] as string | null,
  }));
  spans[Math.floor(rand() * spans.length)]!.text =
    lists.replacements[Math.floor(rand() * lists.replacements.length)]!;
  const kept = spans.filter((s) => s.text !== null);
  if (kept.length > 4) kept[Math.floor(rand() * kept.length)]!.text = null;
  let text = '';
  let pos = 0;
  for (const s of spans) {
    text += plain.slice(pos, s.at) + (s.text ?? '');
    pos = s.at + s.len;
  }
  text = (text + plain.slice(pos)).replace(/\s{2,}/g, ' ').trim();
  return { text, words: words(text) };
}

const lexN = CORPUS_ID === 'synthetic-5M' ? Math.min(LEX_N, 200) : LEX_N;
const querySets: Record<string, Query[]> = {
  lex: randomSources(lexN).map((s) => perturb(s.plain)),
};
if (sidecar.para.length > 0) {
  querySets.para = sidecar.para.map((p) => ({
    text: p.query,
    words: words(p.query),
    partner: p.partner,
  }));
}
const queryDigest = (set: Query[]): string =>
  sha256Json(set.map((q) => ({ words: q.words, partner: q.partner ?? null })));

// ------------------------------------------------------------ naive scan
// Every source variant's words, interned, bucketed by length. FS-1 is at
// most min(len)/max(len), so lengths are visited best bound first and
// the scan stops once no remaining length could beat the best so far —
// exact, not approximate (E-001, "Arms").
log('loading source variants for the naive scan');
const intern = new Map<string, number>();
const byLength = new Map<number, number[][]>();
for (const r of db
  .prepare<[string], { plain: string }>('SELECT plain FROM tuv WHERE lang = ?')
  .iterate(SRC)) {
  const ids = words(r.plain).map((w) => {
    let id = intern.get(w);
    if (id === undefined) intern.set(w, (id = intern.size));
    return id;
  });
  let bucket = byLength.get(ids.length);
  if (!bucket) byLength.set(ids.length, (bucket = []));
  bucket.push(ids);
}
const packed = new Map<number, { data: Int32Array; count: number }>();
for (const [len, list] of byLength) {
  const data = new Int32Array(len * list.length);
  list.forEach((ids, i) => data.set(ids, i * len));
  packed.set(len, { data, count: list.length });
}
byLength.clear();
const lengths = [...packed.keys()];
const scratch = new Int32Array(1 << 16);

function naiveBest(q: string[]): number {
  let unknown = -1;
  const local = new Map<string, number>();
  const qIds = Int32Array.from(q, (w) => {
    const id = intern.get(w) ?? local.get(w);
    if (id !== undefined) return id;
    local.set(w, unknown);
    return unknown--;
  });
  const n = qIds.length;
  const order = lengths
    .map((len) => ({ len, bound: len === 0 ? 0 : Math.min(n, len) / Math.max(n, len) }))
    .sort((a, b) => b.bound - a.bound);
  let best = 0;
  for (const { len, bound } of order) {
    if (bound < best) break;
    const { data, count } = packed.get(len)!;
    for (let i = 0; i < count; i++) {
      const s = fuzzyScore(qIds, data.subarray(i * len, (i + 1) * len), scratch);
      if (s > best) best = s;
    }
  }
  return best;
}

// ------------------------------------------------------------------ arms
const ftsStmt = db.prepare<[string, string, number], { id: number; plain: string }>(
  `SELECT v.id, v.plain FROM tuv_fts f JOIN tuv v ON v.id = f.rowid
   WHERE tuv_fts MATCH ? AND v.lang = ? ORDER BY f.rank LIMIT ?`,
);
const plainOf = db.prepare<[number], { plain: string }>(
  'SELECT plain FROM tuv WHERE id = ?',
);

interface ArmResult {
  best: number;
  ids: Set<number>;
}

function ftsArm(q: Query, limit: number): ArmResult {
  const match = [...new Set(q.words.filter((w) => !lists.stopwords.has(w)))]
    .map((w) => `"${w}"`)
    .join(' OR ');
  const ids = new Set<number>();
  let best = 0;
  if (match !== '') {
    for (const r of ftsStmt.iterate(match, SRC, limit)) {
      ids.add(r.id);
      const s = fuzzyScore(q.words, words(r.plain), scratch);
      if (s > best) best = s;
    }
  }
  return { best, ids };
}

const found = (arm: ArmResult, best: number): boolean => arm.best >= best - 1e-9;

function timed<T>(fn: () => T): [T, number] {
  const t = process.hrtime.bigint();
  const r = fn();
  return [r, msSince(t)];
}
async function timedAsync<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = process.hrtime.bigint();
  const r = await fn();
  return [r, msSince(t)];
}

type Metrics = Record<string, unknown>;

interface ModelFree {
  readonly best: Record<string, number[]>;
  readonly fts50: Record<string, ArmResult[]>;
  readonly ftsK: Record<string, Record<number, ArmResult[]>>;
  readonly fts50p99: Record<string, number>;
  readonly metrics: Metrics;
}

function runModelFree(): ModelFree {
  const metrics: Metrics = {};
  const best: Record<string, number[]> = {};
  const fts50: Record<string, ArmResult[]> = {};
  const ftsK: Record<string, Record<number, ArmResult[]>> = {};
  const fts50p99: Record<string, number> = {};
  for (const [set, qs] of Object.entries(querySets)) {
    log(`${set}: naive scan, ${qs.length} queries`);
    metrics[`queries.${set}.n`] = qs.length;
    metrics[`queries.${set}.sha256`] = queryDigest(qs);
    const naiveMs: number[] = [];
    best[set] = qs.map((q) => {
      const [b, ms] = timed(() => naiveBest(q.words));
      naiveMs.push(ms);
      return b;
    });
    metrics[`latency_ms.${set}.naive`] = summarize(naiveMs);

    log(`${set}: FTS arms`);
    const arms: Array<[string, number]> = [
      ['fts50', FTS_K],
      ...M_VALUES.map((m): [string, number] => [`ftsK_m${m}`, FTS_K + m]),
    ];
    ftsK[set] = {};
    for (const [arm, limit] of arms) {
      const ms: number[] = [];
      const results = qs.map((q) => {
        const [r, t] = timed(() => ftsArm(q, limit));
        ms.push(t);
        return r;
      });
      if (arm === 'fts50') fts50[set] = results;
      else ftsK[set]![limit - FTS_K] = results;
      const lat = summarize(ms);
      if (arm === 'fts50') fts50p99[set] = lat.p99;
      metrics[`recall.${set}.${arm}`] = share(results, (r, i) =>
        found(r, best[set]![i]!),
      );
      metrics[`latency_ms.${set}.${arm}`] = lat;
      if (set === 'para') {
        metrics[`partner_recall.para.${arm}`] = share(results, (r, i) =>
          r.ids.has(qs[i]!.partner!),
        );
      }
    }
  }
  return { best, fts50, ftsK, fts50p99, metrics };
}

function share<T>(xs: readonly T[], pred: (x: T, i: number) => boolean): number {
  return xs.length === 0 ? NaN : xs.filter(pred).length / xs.length;
}

async function embedMemory(
  embedder: Embedder,
  metrics: Metrics,
): Promise<{ resumed: boolean }> {
  const model = embedder.model;
  const already = loadVectors(db, { model, lang: SRC }).ids.length;
  const statBytes = (): number =>
    (
      db
        .prepare(
          "SELECT COALESCE(SUM(pgsize), 0) AS n FROM dbstat WHERE name = 'tuv_vec'",
        )
        .get() as { n: number }
    ).n;
  db.pragma('wal_checkpoint(TRUNCATE)');
  const fileBefore = statSync(ctmPath).size;
  const vecBefore = statBytes();
  let units = 0;
  let afterId = 0;
  const t = process.hrtime.bigint();
  for (;;) {
    const todo = unembeddedVariants(db, {
      model,
      lang: SRC,
      afterId,
      limit: EMBED_CHUNK,
    });
    if (todo.length === 0) break;
    afterId = todo[todo.length - 1]!.tuvId;
    // Similar lengths per forward pass: less padding, same vectors.
    const sorted = [...todo].sort((a, b) => a.plain.length - b.plain.length);
    const vecs = await embedder.embed(sorted.map((v) => v.plain));
    writeVectors(
      db,
      model,
      sorted.map((v, i) => ({ tuvId: v.tuvId, vec: vecs[i]! })),
    );
    units += todo.length;
    if (units % (EMBED_CHUNK * 25) < EMBED_CHUNK) {
      const rate = units / (msSince(t) / 1000);
      log(`  embedded ${units.toLocaleString('en')} (${rate.toFixed(0)}/s)`);
    }
  }
  const ms = msSince(t);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const total = already + units;
  metrics['embed.units'] = units;
  metrics['embed.ms'] = ms;
  metrics['embed.units_per_sec'] = units === 0 ? null : units / (ms / 1000);
  metrics['embed.peak_rss_mib'] = peakRssMiB();
  metrics['storage.tuv_vec_bytes'] = statBytes() - vecBefore;
  metrics['storage.bytes_per_unit'] =
    units === 0 ? null : (statBytes() - vecBefore) / units;
  metrics['storage.ctm_bytes_before'] = fileBefore;
  metrics['storage.ctm_bytes_after'] = statSync(ctmPath).size;
  log(
    `  ${total.toLocaleString('en')} vectors (${units} new) in ${(ms / 1000).toFixed(0)} s`,
  );
  return { resumed: already > 0 };
}

async function runModel(
  key: E001ModelKey,
  free: ModelFree,
): Promise<{ metrics: Metrics; notes: string[] }> {
  const model: EmbeddingModel = E001_MODELS[key];
  const metrics: Metrics = {};
  const notes: string[] = [];
  log(`${key}: loading model`);
  const embedder = await transformersEmbedder(model, { cacheDir: values['model-cache'] });
  log(`${key}: embedding the memory`);
  const { resumed } = await embedMemory(embedder, metrics);
  notes.push('embed.peak_rss_mib is the whole process, naive-scan index included');
  if (resumed) notes.push('embedding resumed: embed.* covers this process only');
  const set: VectorSet = loadVectors(db, { model, lang: SRC });
  const embedMs: number[] = [];
  const searchMs: number[] = [];

  // The vector top-m, by the method under test.
  let search = (vec: Float32Array, m: number): Array<{ tuvId: number }> =>
    topByDot(set, vec, m);
  const overlap: Record<number, number[]> = {};
  if (SEARCH === 'hnsw') {
    log(`${key}: building HNSW over ${set.ids.length} vectors`);
    const n = set.ids.length;
    const index = new hnswlib.HierarchicalNSW('ip', set.dim);
    const [, buildMs] = timed(() => {
      index.initIndex(n, HNSW.M, HNSW.efConstruction, HNSW.seed);
      for (let r = 0; r < n; r++) {
        index.addPoint(Array.from(set.data.subarray(r * set.dim, (r + 1) * set.dim)), r);
      }
    });
    index.setEf(HNSW.efSearch);
    metrics['hnsw.build_ms'] = buildMs;
    search = (vec, m) =>
      index.searchKnn(Array.from(vec), Math.min(m, n)).neighbors.map((r) => ({
        tuvId: set.ids[r]!,
      }));
    // hnsw.recall_vs_exact: every query of every set, untimed.
    for (const queries of Object.values(querySets)) {
      for (const q of queries) {
        const [vec] = await embedder.embed([q.text]);
        for (const m of M_VALUES) {
          const exact = new Set(topByDot(set, vec!, m).map((r) => r.tuvId));
          const got = search(vec!, m).filter((r) => exact.has(r.tuvId)).length;
          (overlap[m] ??= []).push(exact.size === 0 ? 1 : got / exact.size);
        }
      }
    }
    for (const m of M_VALUES) {
      const xs = overlap[m] ?? [];
      metrics[`hnsw.recall_vs_exact.m${m}`] = xs.reduce((a, b) => a + b, 0) / xs.length;
    }
  }

  for (const [qs, queries] of Object.entries(querySets)) {
    log(`${key}: ${qs} vector arms`);
    const best = free.best[qs]!;
    for (const m of M_VALUES) {
      const unionMs: number[] = [];
      const vecMs: number[] = [];
      const union: ArmResult[] = [];
      const vecOnly: ArmResult[] = [];
      for (const q of queries) {
        // union: the FTS top-50 lookup plus the vector top-m, scored.
        const [u, uMs] = await timedAsync(async () => {
          const fts = ftsArm(q, FTS_K);
          const [[vec], eMs] = await timedAsync(() => embedder.embed([q.text]));
          const [top, sMs] = timed(() => search(vec!, m));
          embedMs.push(eMs);
          searchMs.push(sMs);
          const ids = new Set(fts.ids);
          let bestU = fts.best;
          for (const { tuvId } of top) {
            if (ids.has(tuvId)) continue;
            ids.add(tuvId);
            const s = fuzzyScore(q.words, words(plainOf.get(tuvId)!.plain), scratch);
            if (s > bestU) bestU = s;
          }
          return { best: bestU, ids };
        });
        union.push(u);
        unionMs.push(uMs);
        // vecOnly: the vector top-m alone.
        const [v, vMs] = await timedAsync(async () => {
          const [vec] = await embedder.embed([q.text]);
          const ids = new Set<number>();
          let bestV = 0;
          for (const { tuvId } of search(vec!, m)) {
            ids.add(tuvId);
            const s = fuzzyScore(q.words, words(plainOf.get(tuvId)!.plain), scratch);
            if (s > bestV) bestV = s;
          }
          return { best: bestV, ids };
        });
        vecOnly.push(v);
        vecMs.push(vMs);
      }
      const ctl = free.ftsK[qs]![m]!;
      let unionOnly = 0;
      let ftsKOnly = 0;
      union.forEach((u, i) => {
        const a = found(u, best[i]!);
        const b = found(ctl[i]!, best[i]!);
        if (a && !b) unionOnly++;
        if (b && !a) ftsKOnly++;
      });
      const uLat = summarize(unionMs);
      metrics[`recall.${qs}.union_m${m}`] = share(union, (r, i) => found(r, best[i]!));
      metrics[`recall.${qs}.vecOnly_m${m}`] = share(vecOnly, (r, i) =>
        found(r, best[i]!),
      );
      metrics[`discordant.${qs}.union_m${m}`] = {
        union_only: unionOnly,
        ftsK_only: ftsKOnly,
      };
      metrics[`mcnemar_p.${qs}.union_m${m}`] = mcnemarOneSided(unionOnly, ftsKOnly);
      metrics[`latency_ms.${qs}.union_m${m}`] = uLat;
      metrics[`latency_ms.${qs}.vecOnly_m${m}`] = summarize(vecMs);
      metrics[`budget_met.${qs}.union_m${m}`] =
        uLat.p99 <= free.fts50p99[qs]! + BUDGET_MS;
      if (qs === 'para') {
        metrics[`partner_recall.para.union_m${m}`] = share(union, (r, i) =>
          r.ids.has(queries[i]!.partner!),
        );
        metrics[`partner_recall.para.vecOnly_m${m}`] = share(vecOnly, (r, i) =>
          r.ids.has(queries[i]!.partner!),
        );
      }
    }
  }
  metrics['latency_ms.embed_query'] = summarize(embedMs);
  metrics[`latency_ms.vector_search.${SEARCH}`] = summarize(searchMs);
  return { metrics, notes };
}

// --------------------------------------------------------------- results
function runId(): string {
  const prefix = `${startedAt.slice(0, 10)}-${commit.slice(0, 7)}-`;
  const taken = readdirSync(OUT).filter((f) => f.startsWith(prefix)).length;
  return `${prefix}${taken + 1}`;
}

function writeResult(
  model: EmbeddingModel | null,
  outcome: 'completed' | 'failed',
  metrics: Metrics,
  notes: string[],
): void {
  const run = runId();
  const body = {
    schema: 1,
    experiment: 'E-001',
    run,
    hypotheses: ['H1', 'H1b'],
    confirmatory: !values.exploratory,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    outcome,
    code: { commit, dirty },
    corpus: {
      id: CORPUS_ID,
      sha256: corpusSha256,
      units: sidecar?.units ?? null,
      langs: [SRC, TGT],
      para_eligible: sidecar?.paraEligible ?? null,
    },
    model:
      model === null
        ? null
        : {
            id: model.repo,
            revision: model.revision,
            dim: model.dim,
            pooling: model.pooling,
            dtype: model.dtype,
            prefix: model.prefix,
          },
    params: {
      fts_k: FTS_K,
      vec_m: M_VALUES,
      fuzzy_scorer: 'FS-1',
      vector_search: SEARCH,
      hnsw: SEARCH === 'hnsw' ? HNSW : null,
      seed: SEED,
      budget_ms: BUDGET_MS,
      max_units: values['max-units'] === undefined ? null : Number(values['max-units']),
    },
    machine,
    metrics: sortKeys(metrics),
    notes: [values.notes, ...notes].filter(Boolean).join('; '),
  };
  const path = join(OUT, `${run}.json`);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  log(`wrote ${path}`);
}

function sortKeys(m: Metrics): Metrics {
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
}

/** An error message can quote client text; a private run keeps only its kind. */
function failureNote(e: unknown): string {
  const err = e instanceof Error ? e : new Error(String(e));
  return CORPUS === 'sdltm'
    ? `failed: ${err.name}`
    : `failed: ${err.message.slice(0, 300)}`;
}

const free = runModelFree();
writeResult(null, 'completed', free.metrics, []);
for (const key of MODEL_KEYS) {
  try {
    const { metrics, notes } = await runModel(key, free);
    writeResult(E001_MODELS[key], 'completed', metrics, notes);
  } catch (e) {
    log(`${key} failed: ${e instanceof Error ? e.stack : String(e)}`);
    writeResult(E001_MODELS[key], 'failed', {}, [failureNote(e)]);
  }
}
db.close();
if (!values.keep) {
  removeDb(ctmPath);
  rmSync(sidecarPath, { force: true });
}
