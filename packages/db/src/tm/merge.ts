/**
 * Merging two `.ctm` files (tm-format-spec.md §7; backlog #15d).
 *
 * `mergeTm(db, sourcePath, { actor })` folds the source memory into the
 * open destination: units by `uuid`, then variants by `lang`, last writer
 * winning with the loser kept in `tuv_history`. The spec's rules and what
 * building them settled are in §7's implementation note; the one-line
 * version of each decision is next to the SQL that makes it.
 *
 * Set-based on purpose. A memory runs to millions of units (§11), so the
 * merge is a handful of `INSERT … SELECT` / `UPDATE … FROM` statements
 * over two temporary maps of what lines up with what, never a row at a
 * time through JS. The source is attached and only ever read.
 */

import { existsSync, realpathSync } from 'node:fs';

import type { AuditActor } from '@cat-tool/core';
import { formatActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { TmError } from './errors.js';
import { refreshLangs } from './write.js';
import { TM_APPLICATION_ID, TM_MIGRATIONS } from './schema.js';

const SRC = 'merge_src';

export interface MergeTmOptions {
  /**
   * Who ran the merge. Required, as for every write that matters
   * (`audit-spec.md` §2.1): its label stamps the revisions the merge
   * retains in `tuv_history`. A `.ctm` has no `audit_event` yet.
   */
  readonly actor: AuditActor;
}

export interface MergeTmResult {
  /** Units the source had and the destination did not, copied with everything under them. */
  readonly unitsAdded: number;
  /** Live destination units the source's tombstone deleted. */
  readonly tombstonesPropagated: number;
  /** Variants copied across: new units' and a language the destination lacked. */
  readonly variantsAdded: number;
  /** Variants where the source won, the destination's content differing. */
  readonly variantsReplaced: number;
  /** Variants where the destination won, the source's content differing. */
  readonly variantsKept: number;
  /** Displaced revisions written to `tuv_history`. */
  readonly historyRetained: number;
  /** The source's own history rows copied across. */
  readonly historyCopied: number;
  /**
   * History slots two different revisions wanted at once, so one was not
   * kept here (§7 note). The source file still has it.
   */
  readonly historyConflicts: number;
  /** Things a merge did not resolve and left as they were. */
  readonly warnings: readonly string[];
}

const EMPTY: MergeTmResult = {
  unitsAdded: 0,
  tombstonesPropagated: 0,
  variantsAdded: 0,
  variantsReplaced: 0,
  variantsKept: 0,
  historyRetained: 0,
  historyCopied: 0,
  historyConflicts: 0,
  warnings: [],
};

const int = (db: Database.Database, sql: string): number =>
  (db.prepare(sql).get() as { n: number }).n;

/**
 * `SET col = expr, …` and the `WHERE` that skips a row the update would
 * leave as it is, from one list — so a merge that changes nothing writes
 * nothing, and the two halves cannot drift apart.
 */
function setAndChanged(
  table: string,
  pairs: readonly (readonly [string, string])[],
): { set: string; changed: string } {
  return {
    // SQLite wants the column of a `SET` unqualified, and the same name is
    // ambiguous once the source's table is joined in, hence the prefix here.
    set: pairs.map(([col, expr]) => `${col} = ${expr}`).join(', '),
    changed: pairs.map(([col, expr]) => `${table}.${col} IS NOT ${expr}`).join(' OR '),
  };
}

/** The lesser of two nullable values; a NULL gives way to a value. */
const lesser = (a: string, b: string) =>
  `CASE WHEN ${a} IS NULL THEN ${b} WHEN ${b} IS NULL THEN ${a} ELSE MIN(${a}, ${b}) END`;
const greater = (a: string, b: string) =>
  `CASE WHEN ${a} IS NULL THEN ${b} WHEN ${b} IS NULL THEN ${a} ELSE MAX(${a}, ${b}) END`;

/**
 * Folds the memory at `sourcePath` into `db`, in one transaction.
 *
 * Refused before anything is written: a source that is not a `.ctm`, is
 * a newer format than this build, or was hashed under another
 * `normalizer_version` (every one of its hashes would be wrong here), and
 * a destination marked read-only. The same file as the destination is a
 * no-op.
 */
export function mergeTm(
  db: Database.Database,
  sourcePath: string,
  options: MergeTmOptions,
): MergeTmResult {
  const dest = db
    .prepare('SELECT normalizer_version, read_only FROM tm WHERE id = 1')
    .get() as { normalizer_version: number; read_only: number } | undefined;
  if (!dest) throw new TmError('the destination memory has no identity row');
  if (dest.read_only) throw new TmError('the destination memory is read-only');

  if (!existsSync(sourcePath)) {
    // `ATTACH` would create it, and merging an empty file is a typo, not a merge.
    throw new TmError(`no memory at "${sourcePath}"`);
  }
  if (
    db.name !== ':memory:' &&
    db.name !== '' &&
    realpathSync(db.name) === realpathSync(sourcePath)
  ) {
    return EMPTY;
  }
  const attached = (db.pragma('database_list') as Array<{ name: string }>).some(
    (d) => d.name === SRC,
  );
  if (attached) throw new TmError('a merge is already running on this connection');

  try {
    db.prepare(`ATTACH DATABASE ? AS ${SRC}`).run(sourcePath);
  } catch {
    // SQLite reads the header here: a file that is not a database fails now.
    throw new TmError(`"${sourcePath}" is not a .ctm memory`);
  }
  try {
    assertMergeable(db, sourcePath, dest.normalizer_version);
    return db.transaction(() => merge(db, options.actor))();
  } finally {
    db.exec(`DETACH DATABASE ${SRC}`);
  }
}

function assertMergeable(
  db: Database.Database,
  sourcePath: string,
  normalizerVersion: number,
): void {
  let appId: number;
  let version: number;
  try {
    appId = db.pragma(`${SRC}.application_id`, { simple: true }) as number;
    version = db.pragma(`${SRC}.user_version`, { simple: true }) as number;
  } catch {
    // `ATTACH` is lazy: a file that is not a database fails on first read.
    throw new TmError(`"${sourcePath}" is not a .ctm memory`);
  }
  const newest = TM_MIGRATIONS[TM_MIGRATIONS.length - 1]!.version;
  if (appId !== TM_APPLICATION_ID || version < 1) {
    throw new TmError(`"${sourcePath}" is not a .ctm memory`);
  }
  if (version > newest) {
    throw new TmError(
      `"${sourcePath}" is format version ${version}, newer than the ${newest} this build ` +
        'understands — update the application before merging it',
    );
  }
  const src = db
    .prepare(`SELECT normalizer_version FROM ${SRC}.tm WHERE id = 1`)
    .get() as { normalizer_version: number } | undefined;
  if (!src) throw new TmError(`"${sourcePath}" has no identity row`);
  if (src.normalizer_version !== normalizerVersion) {
    throw new TmError(
      `"${sourcePath}" was hashed under normalizer_version ${src.normalizer_version}, this ` +
        `memory under ${normalizerVersion}: merging would leave hashes that match nothing. ` +
        'Rehash one of them first.',
    );
  }
}

function merge(db: Database.Database, actor: AuditActor): MergeTmResult {
  const now = new Date().toISOString();
  const by = actor.label ?? formatActor(actor.actor);

  // --- what lines up with what ---------------------------------------
  // `d_*` is the destination unit before the merge, `s_*` the source's.
  db.exec(`
    CREATE TEMP TABLE merge_unit AS
    SELECT s.id AS s_id, d.id AS d_id, s.uuid AS uuid, d.id IS NULL AS is_new,
           d.rev AS d_rev, d.updated_at AS d_updated, d.deleted AS d_deleted,
           s.rev AS s_rev, s.updated_at AS s_updated, s.deleted AS s_deleted
    FROM   ${SRC}.tu s LEFT JOIN main.tu d ON d.uuid = s.uuid;
    CREATE INDEX temp.merge_unit_s ON merge_unit(s_id);
  `);

  // --- units the destination lacks: copied whole ----------------------
  const unitsAdded = db
    .prepare(
      `INSERT INTO main.tu (uuid, rev, created_at, updated_at, created_by,
                            origin_doc, origin_project, deleted)
       SELECT s.uuid, s.rev, s.created_at, s.updated_at, s.created_by,
              s.origin_doc, s.origin_project, s.deleted
       FROM   ${SRC}.tu s JOIN merge_unit m ON m.s_id = s.id
       WHERE  m.is_new ORDER BY s.id`,
    )
    .run().changes;
  db.exec(
    `UPDATE merge_unit SET d_id = (SELECT id FROM main.tu WHERE uuid = merge_unit.uuid)
     WHERE d_id IS NULL`,
  );

  // --- unit attributes -------------------------------------------------
  // Before the unit rows move, which the rule below compares against.
  db.exec(`
    INSERT OR IGNORE INTO main.tu_attr (tu_id, key, value)
    SELECT m.d_id, a.key, a.value
    FROM   ${SRC}.tu_attr a JOIN merge_unit m ON m.s_id = a.tu_id;

    UPDATE main.tu_attr SET value = a.value
    FROM   ${SRC}.tu_attr a JOIN merge_unit m ON m.s_id = a.tu_id
    WHERE  tu_attr.tu_id = m.d_id AND tu_attr.key = a.key AND NOT m.is_new
      AND  tu_attr.value <> a.value
      AND  (m.s_rev, m.s_updated, a.value) > (m.d_rev, m.d_updated, tu_attr.value);
  `);

  // --- unit rows: tombstones never resurrect --------------------------
  const unit = setAndChanged('tu', [
    ['rev', 'MAX(tu.rev, s.rev)'],
    ['updated_at', 'MAX(tu.updated_at, s.updated_at)'],
    ['deleted', 'MAX(tu.deleted, s.deleted)'],
    ['created_at', 'MIN(tu.created_at, s.created_at)'],
    ['created_by', lesser('tu.created_by', 's.created_by')],
    ['origin_doc', lesser('tu.origin_doc', 's.origin_doc')],
    ['origin_project', lesser('tu.origin_project', 's.origin_project')],
  ]);
  db.exec(`
    UPDATE main.tu SET ${unit.set}
    FROM   merge_unit m JOIN ${SRC}.tu s ON s.id = m.s_id
    WHERE  tu.id = m.d_id AND NOT m.is_new AND (${unit.changed});
  `);
  const tombstonesPropagated = int(
    db,
    `SELECT COUNT(*) AS n FROM merge_unit
     WHERE NOT is_new AND d_deleted = 0 AND s_deleted = 1`,
  );

  // --- variants ---------------------------------------------------------
  // The winner is the greater by (rev, updated_at, content): content last
  // so the result never depends on which file is the destination.
  const key = (t: string) =>
    `${t}.rev, ${t}.updated_at, ${t}.tokens, ${t}.quality, ` +
    `COALESCE(${t}.prev_hash, ''), COALESCE(${t}.next_hash, '')`;
  db.exec(`
    CREATE TEMP TABLE merge_tuv AS
    SELECT s.id AS s_id, d.id AS d_id, m.d_id AS tu_id, s.lang AS lang,
           CASE WHEN d.id IS NULL THEN 'add'
                WHEN (${key('s')}) > (${key('d')}) THEN 'src'
                ELSE 'dst' END AS outcome,
           COALESCE(s.tokens <> d.tokens OR s.quality <> d.quality
                    OR s.prev_hash IS NOT d.prev_hash OR s.next_hash IS NOT d.next_hash,
                    0) AS differs,
           COALESCE(s.rev = d.rev, 0) AS same_rev
    FROM   ${SRC}.tuv s JOIN merge_unit m ON m.s_id = s.tu_id
           LEFT JOIN main.tuv d ON d.tu_id = m.d_id AND d.lang = s.lang;
    CREATE INDEX temp.merge_tuv_s ON merge_tuv(s_id);
  `);
  const outcomes = db
    .prepare(
      `SELECT outcome, differs, COUNT(*) AS n FROM merge_tuv GROUP BY outcome, differs`,
    )
    .all() as Array<{ outcome: string; differs: number; n: number }>;
  const count = (outcome: string, differs?: number) =>
    outcomes
      .filter(
        (o) => o.outcome === outcome && (differs === undefined || o.differs === differs),
      )
      .reduce((sum, o) => sum + o.n, 0);

  // What a displaced revision's history row would hold, and whether its
  // slot is already taken — by the same content (nothing to do) or by
  // other content (a conflict, reported).
  const retained = `
    SELECT t.d_id AS tuv_id,
           CASE t.outcome WHEN 'src' THEN d.rev ELSE s.rev END AS rev,
           CASE t.outcome WHEN 'src' THEN d.tokens ELSE s.tokens END AS tokens,
           CASE t.outcome WHEN 'src' THEN d.quality ELSE s.quality END AS quality
    FROM   merge_tuv t JOIN ${SRC}.tuv s ON s.id = t.s_id JOIN main.tuv d ON d.id = t.d_id
    WHERE  t.outcome IN ('src', 'dst') AND t.differs`;
  let historyConflicts = int(
    db,
    `SELECT COUNT(*) AS n FROM (${retained}) r JOIN main.tuv_history h
       ON h.tuv_id = r.tuv_id AND h.rev = r.rev
     WHERE h.tokens <> r.tokens OR h.quality <> r.quality`,
  );
  const historyRetained = db
    .prepare(
      `INSERT OR IGNORE INTO main.tuv_history (tuv_id, rev, tokens, quality, changed_at, changed_by)
       SELECT tuv_id, rev, tokens, quality, @now, @by FROM (${retained})`,
    )
    .run({ now, by }).changes;

  // Copy the variants the destination lacks, then give them their ids.
  db.exec(`
    INSERT INTO main.tuv (tu_id, lang, rev, tokens, plain, hash, prev_hash, next_hash, quality,
                          usage_count, last_used_at, created_at, updated_at, updated_by)
    SELECT t.tu_id, s.lang, s.rev, s.tokens, s.plain, s.hash, s.prev_hash, s.next_hash, s.quality,
           s.usage_count, s.last_used_at, s.created_at, s.updated_at, s.updated_by
    FROM   merge_tuv t JOIN ${SRC}.tuv s ON s.id = t.s_id
    WHERE  t.outcome = 'add' ORDER BY t.s_id;
    UPDATE merge_tuv SET d_id = (SELECT id FROM main.tuv
                                 WHERE tu_id = merge_tuv.tu_id AND lang = merge_tuv.lang)
    WHERE d_id IS NULL;
  `);

  // The source's own history rows, for every variant that lined up.
  historyConflicts += int(
    db,
    `SELECT COUNT(*) AS n
     FROM   merge_tuv t JOIN ${SRC}.tuv_history sh ON sh.tuv_id = t.s_id
            JOIN main.tuv_history h ON h.tuv_id = t.d_id AND h.rev = sh.rev
     WHERE  h.tokens <> sh.tokens OR h.quality <> sh.quality`,
  );
  const historyCopied = db
    .prepare(
      `INSERT OR IGNORE INTO main.tuv_history (tuv_id, rev, tokens, quality, changed_at, changed_by)
       SELECT t.d_id, sh.rev, sh.tokens, sh.quality, sh.changed_at, sh.changed_by
       FROM   merge_tuv t JOIN ${SRC}.tuv_history sh ON sh.tuv_id = t.s_id`,
    )
    .run().changes;

  // A vector is of one `plain` (§2.8.3): the source winning with other
  // text strands the destination's.
  db.exec(`
    DELETE FROM main.tuv_vec WHERE tuv_id IN (
      SELECT t.d_id FROM merge_tuv t JOIN ${SRC}.tuv s ON s.id = t.s_id
             JOIN main.tuv d ON d.id = t.d_id
      WHERE  t.outcome = 'src' AND d.plain <> s.plain);
  `);

  // The winner's content. A diverged tie takes the next revision, so its
  // own next edit does not retain into the slot the loser now holds.
  db.exec(`
    UPDATE main.tuv
    SET    rev = CASE WHEN t.differs AND t.same_rev THEN s.rev + 1 ELSE s.rev END,
           tokens = s.tokens, plain = s.plain, hash = s.hash,
           prev_hash = s.prev_hash, next_hash = s.next_hash, quality = s.quality,
           updated_at = s.updated_at, updated_by = s.updated_by
    FROM   merge_tuv t JOIN ${SRC}.tuv s ON s.id = t.s_id
    WHERE  tuv.id = t.d_id AND t.outcome = 'src';

    UPDATE main.tuv SET rev = rev + 1
    WHERE  id IN (SELECT d_id FROM merge_tuv WHERE outcome = 'dst' AND differs AND same_rev);
  `);

  // What does not depend on who won, taken so that merging twice, or in
  // either direction, gives the same number.
  const counters = setAndChanged('tuv', [
    ['usage_count', 'MAX(tuv.usage_count, s.usage_count)'],
    ['last_used_at', greater('tuv.last_used_at', 's.last_used_at')],
    ['created_at', 'MIN(tuv.created_at, s.created_at)'],
  ]);
  db.exec(`
    UPDATE main.tuv SET ${counters.set}
    FROM   merge_tuv t JOIN ${SRC}.tuv s ON s.id = t.s_id
    WHERE  tuv.id = t.d_id AND t.outcome IN ('src', 'dst') AND (${counters.changed});
  `);

  // --- segmentation profiles --------------------------------------------
  db.exec(
    `INSERT OR IGNORE INTO main.seg_profile (lang, delta)
     SELECT lang, delta FROM ${SRC}.seg_profile`,
  );
  const profileClashes = db
    .prepare(
      `SELECT s.lang AS lang FROM ${SRC}.seg_profile s JOIN main.seg_profile d ON d.lang = s.lang
       WHERE s.delta <> d.delta ORDER BY s.lang`,
    )
    .all() as Array<{ lang: string }>;
  const warnings = profileClashes.map(
    (r) =>
      `segmentation rules for "${r.lang}" differ between the two memories; ` +
      "the destination's were kept",
  );

  refreshLangs(db);
  db.exec('DROP TABLE temp.merge_tuv; DROP TABLE temp.merge_unit;');

  return {
    unitsAdded,
    tombstonesPropagated,
    variantsAdded: count('add'),
    variantsReplaced: count('src', 1),
    variantsKept: count('dst', 1),
    historyRetained,
    historyCopied,
    historyConflicts,
    warnings,
  };
}
