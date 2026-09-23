/**
 * Production write-back into a `.ctm` file (tm-format-spec.md §2, §5,
 * §6; backlog #20).
 *
 * `db/tm/*.test.ts` files each have their own `insertUnit`/`insertTu`
 * helpers, but those are test fixtures, not a real write path — this
 * module is that path: the one place outside a test file that inserts
 * or updates a `tu`/`tuv` row for real translation work. `db/project/
 * confirm.ts` is its only caller today (v1-spec.md §6.2's write-back
 * on confirm); a future manual TM-editing feature would call it too,
 * rather than writing raw SQL of its own.
 */

import { randomUUID } from 'node:crypto';

import { normalizeTokens } from '@cat-tool/core';
import type { TagKind, TmToken } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { qualifySchema } from '../schema-alias.js';
import { QUALITY } from './schema.js';

export class WriteBackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteBackError';
  }
}

export interface VariantInput {
  readonly lang: string;
  readonly tokens: readonly TmToken[];
  readonly prevHash?: string | null;
  readonly nextHash?: string | null;
  readonly updatedBy?: string | null;
}

export interface WriteBackParams {
  readonly source: VariantInput;
  readonly target: VariantInput;
}

export interface WriteBackOptions {
  /** Schema alias of an `ATTACH`ed `.ctm`; omitted for the main database. */
  readonly schema?: string;
}

export interface VariantWriteResult {
  readonly tuvId: number;
  readonly rev: number;
  readonly created: boolean;
  /**
   * Whether the previous value of this variant was preserved in
   * `tuv_history` before being overwritten — v1-spec.md §6.2's "keeps
   * the old one only if the two differ in tags", resolved here as a
   * `TagKind` multiset comparison (never true for a brand-new variant,
   * since there is no previous value to preserve).
   */
  readonly historized: boolean;
}

export interface WriteBackResult {
  readonly tuId: number;
  readonly tuCreated: boolean;
  readonly source: VariantWriteResult;
  readonly target: VariantWriteResult;
}

/**
 * Upserts one translation unit's source and target variants together,
 * as one transaction, keyed on the source variant's `(lang, hash)` —
 * v1-spec.md §6.2's "upsert ... keyed on source_hash". Reuses an
 * existing `tu` when a variant with that `(lang, hash)` already exists
 * in this TM (so confirming a second language against an
 * already-known source lands on the same multilingual unit,
 * `tm-format-spec.md` §2); creates a fresh `tu` otherwise.
 *
 * Quality never drops (`tm-format-spec.md` §6: "re-confirming something
 * already reviewed leaves it reviewed") and a variant whose new tag
 * structure differs from what was stored is preserved in
 * `tuv_history` before being overwritten, never silently discarded.
 */
export function writeBack(
  db: Database.Database,
  params: WriteBackParams,
  options: WriteBackOptions = {},
): WriteBackResult {
  if (params.source.lang === params.target.lang) {
    throw new WriteBackError(
      `source and target are both "${params.source.lang}" — a unit needs two ` +
        'distinct language variants, not the same one twice',
    );
  }
  const q = qualifySchema(options.schema);
  return db.transaction((): WriteBackResult => {
    const now = new Date().toISOString();
    const { tuId, created: tuCreated } = findOrCreateTu(db, q, params.source, now);
    const source = upsertVariant(db, q, tuId, params.source, now);
    const target = upsertVariant(db, q, tuId, params.target, now);
    refreshLangs(db, { schema: options.schema });
    return { tuId, tuCreated, source, target };
  })();
}

function findOrCreateTu(
  db: Database.Database,
  q: string,
  sourceVariant: VariantInput,
  now: string,
): { readonly tuId: number; readonly created: boolean } {
  const { hash } = normalizeTokens(sourceVariant.tokens);
  const existing = db
    .prepare(
      `SELECT t.id AS id
       FROM   ${q}tu t
       JOIN   ${q}tuv v ON v.tu_id = t.id
       WHERE  t.deleted = 0 AND v.lang = ? AND v.hash = ?
       LIMIT 1`,
    )
    .get(sourceVariant.lang, hash) as { id: number } | undefined;
  if (existing) return { tuId: existing.id, created: false };

  const info = db
    .prepare(`INSERT INTO ${q}tu (uuid, created_at, updated_at) VALUES (?, ?, ?)`)
    .run(randomUUID(), now, now);
  return { tuId: info.lastInsertRowid as number, created: true };
}

interface ExistingTuvRow {
  id: number;
  rev: number;
  tokens: string;
  quality: number;
}

function upsertVariant(
  db: Database.Database,
  q: string,
  tuId: number,
  variant: VariantInput,
  now: string,
): VariantWriteResult {
  const { plain, hash } = normalizeTokens(variant.tokens);
  const existing = db
    .prepare(`SELECT id, rev, tokens, quality FROM ${q}tuv WHERE tu_id = ? AND lang = ?`)
    .get(tuId, variant.lang) as ExistingTuvRow | undefined;

  if (!existing) {
    const info = db
      .prepare(
        `INSERT INTO ${q}tuv
           (tu_id, lang, rev, tokens, plain, hash, prev_hash, next_hash,
            quality, created_at, updated_at, updated_by)
         VALUES (@tu_id, @lang, 1, @tokens, @plain, @hash, @prev_hash, @next_hash,
                 @quality, @created_at, @updated_at, @updated_by)`,
      )
      .run({
        tu_id: tuId,
        lang: variant.lang,
        tokens: JSON.stringify(variant.tokens),
        plain,
        hash,
        prev_hash: variant.prevHash ?? null,
        next_hash: variant.nextHash ?? null,
        quality: QUALITY.confirmed,
        created_at: now,
        updated_at: now,
        updated_by: variant.updatedBy ?? null,
      });
    return {
      tuvId: info.lastInsertRowid as number,
      rev: 1,
      created: true,
      historized: false,
    };
  }

  const previousTokens = JSON.parse(existing.tokens) as TmToken[];
  const historized = !tagKindMultisetsEqual(previousTokens, variant.tokens);
  if (historized) {
    db.prepare(
      `INSERT INTO ${q}tuv_history (tuv_id, rev, tokens, quality, changed_at, changed_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      existing.id,
      existing.rev,
      existing.tokens,
      existing.quality,
      now,
      variant.updatedBy ?? null,
    );
  }

  const rev = existing.rev + 1;
  const quality = Math.max(existing.quality, QUALITY.confirmed);
  db.prepare(
    `UPDATE ${q}tuv
     SET rev = @rev, tokens = @tokens, plain = @plain, hash = @hash,
         prev_hash = @prev_hash, next_hash = @next_hash, quality = @quality,
         updated_at = @updated_at, updated_by = @updated_by
     WHERE id = @id`,
  ).run({
    id: existing.id,
    rev,
    tokens: JSON.stringify(variant.tokens),
    plain,
    hash,
    prev_hash: variant.prevHash ?? null,
    next_hash: variant.nextHash ?? null,
    quality,
    updated_at: now,
    updated_by: variant.updatedBy ?? null,
  });
  return { tuvId: existing.id, rev, created: false, historized };
}

/**
 * Whether two `TmToken[]` streams carry the same tags, counted by
 * `TagKind` rather than by raw id — the two are independently
 * renumbered from 1 (`toTmTokens`), so identical *ids* would coincide
 * whenever the shapes matched anyway; what actually distinguishes "the
 * same kind of edit" from "the structure changed" is whether the same
 * kinds occur the same number of times. This is v1-spec.md §6.2's "the
 * two differ in tags", resolved as a multiset comparison rather than a
 * position-by-position one — deliberately looser than `tagsMatch`
 * (`core/model/tags.ts`), which compares a segment's own source against
 * its own target from the same tokenisation pass and can rely on shared
 * ids; here the two streams have no such shared origin.
 */
function tagKindMultisetsEqual(a: readonly TmToken[], b: readonly TmToken[]): boolean {
  const countsA = tagKindCounts(a);
  const countsB = tagKindCounts(b);
  if (countsA.size !== countsB.size) return false;
  for (const [kind, count] of countsA) {
    if (countsB.get(kind) !== count) return false;
  }
  return true;
}

function tagKindCounts(tokens: readonly TmToken[]): Map<TagKind | 'unhinted', number> {
  const counts = new Map<TagKind | 'unhinted', number>();
  for (const token of tokens) {
    if (token.t !== 'open' && token.t !== 'ph') continue;
    const key = token.k ?? 'unhinted';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface RefreshLangsOptions {
  readonly schema?: string;
}

/**
 * Recomputes `tm.langs` (tm-format-spec.md §2.1) from what `tuv`
 * actually contains — a projection, never hand-maintained
 * incrementally, so it can never drift. Shared by `writeBack` and
 * `importTmx` (backlog #18) rather than each keeping its own copy.
 */
export function refreshLangs(
  db: Database.Database,
  options: RefreshLangsOptions = {},
): void {
  const q = qualifySchema(options.schema);
  const rows = db
    .prepare(`SELECT DISTINCT lang FROM ${q}tuv ORDER BY lang`)
    .all() as Array<{
    lang: string;
  }>;
  db.prepare(`UPDATE ${q}tm SET langs = ? WHERE id = 1`).run(
    JSON.stringify(rows.map((r) => r.lang)),
  );
}
