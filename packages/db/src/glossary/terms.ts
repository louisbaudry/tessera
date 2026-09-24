/**
 * `.ctg` term repository (smart-glossary-spec.md §3; backlog #39).
 *
 * Writes go to a glossary opened directly (`createGlossary`/
 * `openGlossary`). The read paths that a project needs across *several*
 * glossaries — `findRendering`, `preferredVariant` — also take a
 * `schema` alias so they can run against a `.ctg` `ATTACH`ed onto a
 * project connection (`project/glossary-refs.ts`). Nothing here decides
 * which glossary a decision belongs to; that is the session's job (#41).
 */

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { termKey } from '@cat-tool/core';
import type { DecisionKind, Term, TermDecision, TermVariant } from '@cat-tool/core';

import { ensurePrimarySubtagFn, matchingLangs } from '../lang-match.js';
import { qualifySchema } from '../schema-alias.js';

export class TermError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TermError';
  }
}

interface TermRow {
  id: number;
  uuid: string;
  rev: number;
  created_at: string;
  updated_at: string;
  deleted: number;
}

interface VariantRow {
  id: number;
  term_id: number;
  lang: string;
  rev: number;
  text: string;
  plain: string;
  note: string | null;
  forbidden: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

interface DecisionRow {
  id: number;
  term_id: number;
  lang: string;
  chosen: string;
  rejected: string;
  kind: DecisionKind;
  source_project: string | null;
  source_segment: number | null;
  decided_by: string | null;
  decided_at: string;
}

const fromTermRow = (r: TermRow): Term => ({
  id: r.id,
  uuid: r.uuid,
  rev: r.rev,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deleted: Boolean(r.deleted),
});

const fromVariantRow = (r: VariantRow): TermVariant => ({
  id: r.id,
  termId: r.term_id,
  lang: r.lang,
  rev: r.rev,
  text: r.text,
  plain: r.plain,
  note: r.note,
  forbidden: Boolean(r.forbidden),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

const fromDecisionRow = (r: DecisionRow): TermDecision => ({
  id: r.id,
  termId: r.term_id,
  lang: r.lang,
  chosen: r.chosen,
  rejected: JSON.parse(r.rejected) as string[],
  kind: r.kind,
  sourceProject: r.source_project,
  sourceSegment: r.source_segment,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
});

const now = (): string => new Date().toISOString();

export interface ReadOptions {
  /** Schema alias of an `ATTACH`ed `.ctg`; omitted for the main database. */
  readonly schema?: string;
}

/** `"alias."` or `""` — see `../schema-alias.ts`, shared with `tm/retrieve.ts`. */
const qualify = qualifySchema;

// ---------------------------------------------------------------- term

export function insertTerm(db: Database.Database): Term {
  const at = now();
  const info = db
    .prepare('INSERT INTO term (uuid, created_at, updated_at) VALUES (?, ?, ?)')
    .run(randomUUID(), at, at);
  return getTerm(db, info.lastInsertRowid as number)!;
}

export function getTerm(db: Database.Database, termId: number): Term | null {
  const row = db.prepare('SELECT * FROM term WHERE id = ?').get(termId) as
    TermRow | undefined;
  return row ? fromTermRow(row) : null;
}

/** Tombstones a term (tm-format-spec.md §7). Its variants and decisions stay. */
export function tombstoneTerm(db: Database.Database, termId: number): void {
  const info = db
    .prepare('UPDATE term SET deleted = 1, rev = rev + 1, updated_at = ? WHERE id = ?')
    .run(now(), termId);
  if (info.changes === 0) throw new TermError(`no term with id ${termId}`);
}

// ------------------------------------------------------------- variant

export interface AddVariantOptions {
  readonly termId: number;
  /** BCP-47. */
  readonly lang: string;
  readonly text: string;
  readonly note?: string;
  readonly forbidden?: boolean;
  readonly updatedBy?: string;
}

/**
 * Maintains `glossary.langs` on write, the way `.ctm` maintains
 * `tm.langs`: a denormalised list of what the file contains, so a UI
 * can show it without scanning.
 */
function noteLang(db: Database.Database, lang: string): void {
  const { langs } = db.prepare('SELECT langs FROM glossary WHERE id = 1').get() as {
    langs: string;
  };
  const list = JSON.parse(langs) as string[];
  if (list.includes(lang)) return;
  db.prepare('UPDATE glossary SET langs = ? WHERE id = 1').run(
    JSON.stringify([...list, lang]),
  );
}

export function addVariant(
  db: Database.Database,
  options: AddVariantOptions,
): TermVariant {
  const plain = termKey(options.text);
  if (plain === '') throw new TermError('a term variant needs non-empty text');
  const at = now();
  const id = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO term_variant
           (term_id, lang, text, plain, note, forbidden, created_at, updated_at, updated_by)
         VALUES
           (@term_id, @lang, @text, @plain, @note, @forbidden, @at, @at, @updated_by)`,
      )
      .run({
        term_id: options.termId,
        lang: options.lang,
        text: options.text,
        plain,
        note: options.note ?? null,
        forbidden: options.forbidden ? 1 : 0,
        at,
        updated_by: options.updatedBy ?? null,
      });
    db.prepare('UPDATE term SET updated_at = ? WHERE id = ?').run(at, options.termId);
    noteLang(db, options.lang);
    return info.lastInsertRowid as number;
  })();
  return getVariant(db, id)!;
}

export function getVariant(db: Database.Database, id: number): TermVariant | null {
  const row = db.prepare('SELECT * FROM term_variant WHERE id = ?').get(id) as
    VariantRow | undefined;
  return row ? fromVariantRow(row) : null;
}

export function listVariants(db: Database.Database, termId: number): TermVariant[] {
  const rows = db
    .prepare('SELECT * FROM term_variant WHERE term_id = ? ORDER BY lang, id')
    .all(termId) as VariantRow[];
  return rows.map(fromVariantRow);
}

export interface UpdateVariantOptions {
  readonly text?: string;
  /** `null` clears the note; omitted keeps it. */
  readonly note?: string | null;
  readonly forbidden?: boolean;
  readonly updatedBy?: string;
}

/**
 * Bumps `rev` and copies the previous row into `term_variant_history`
 * first, in one transaction — the `tuv_history` discipline, so a bad
 * edit is survivable and merge (§3.5) has a `rev` to resolve on.
 */
export function updateVariant(
  db: Database.Database,
  id: number,
  options: UpdateVariantOptions,
): TermVariant {
  const at = now();
  db.transaction(() => {
    const old = db.prepare('SELECT * FROM term_variant WHERE id = ?').get(id) as
      VariantRow | undefined;
    if (!old) throw new TermError(`no term_variant with id ${id}`);
    db.prepare(
      `INSERT INTO term_variant_history
         (term_variant_id, rev, text, note, forbidden, changed_at, changed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      old.id,
      old.rev,
      old.text,
      old.note,
      old.forbidden,
      at,
      options.updatedBy ?? null,
    );
    const text = options.text ?? old.text;
    const plain = termKey(text);
    if (plain === '') throw new TermError('a term variant needs non-empty text');
    db.prepare(
      `UPDATE term_variant
       SET text = ?, plain = ?, note = ?, forbidden = ?, rev = rev + 1,
           updated_at = ?, updated_by = ?
       WHERE id = ?`,
    ).run(
      text,
      plain,
      options.note === undefined ? old.note : options.note,
      (options.forbidden ?? Boolean(old.forbidden)) ? 1 : 0,
      at,
      options.updatedBy ?? null,
      id,
    );
    db.prepare('UPDATE term SET updated_at = ? WHERE id = ?').run(at, old.term_id);
  })();
  return getVariant(db, id)!;
}

// ------------------------------------------------------------ decision

export interface RecordDecisionOptions {
  readonly termId: number;
  readonly lang: string;
  /** The chosen rendering; stored as its `termKey`. */
  readonly chosen: string;
  /** Alternatives offered and not taken; stored as their `termKey`s. */
  readonly rejected: readonly string[];
  readonly kind: DecisionKind;
  readonly sourceProject?: string;
  readonly sourceSegment?: number;
  readonly decidedBy?: string;
}

/** Appends to the log. There is no update and no delete — the schema refuses both. */
export function recordDecision(
  db: Database.Database,
  options: RecordDecisionOptions,
): TermDecision {
  const chosen = termKey(options.chosen);
  if (chosen === '') throw new TermError('a decision needs a non-empty chosen rendering');
  const rejected = [...new Set(options.rejected.map(termKey))].filter(
    (r) => r !== '' && r !== chosen,
  );
  const info = db
    .prepare(
      `INSERT INTO term_decision
         (term_id, lang, chosen, rejected, kind, source_project, source_segment,
          decided_by, decided_at)
       VALUES
         (@term_id, @lang, @chosen, @rejected, @kind, @source_project, @source_segment,
          @decided_by, @decided_at)`,
    )
    .run({
      term_id: options.termId,
      lang: options.lang,
      chosen,
      rejected: JSON.stringify(rejected),
      kind: options.kind,
      source_project: options.sourceProject ?? null,
      source_segment: options.sourceSegment ?? null,
      decided_by: options.decidedBy ?? null,
      decided_at: now(),
    });
  const row = db
    .prepare('SELECT * FROM term_decision WHERE id = ?')
    .get(info.lastInsertRowid) as DecisionRow;
  return fromDecisionRow(row);
}

/** A term's decisions, oldest first; optionally for one language (region-insensitive). */
export function listDecisions(
  db: Database.Database,
  termId: number,
  lang?: string,
): TermDecision[] {
  ensurePrimarySubtagFn(db);
  const rows = (
    lang === undefined
      ? db
          .prepare('SELECT * FROM term_decision WHERE term_id = ? ORDER BY id')
          .all(termId)
      : db
          .prepare(
            `SELECT * FROM term_decision
             WHERE term_id = ? AND primary_subtag(lang) = primary_subtag(?)
             ORDER BY id`,
          )
          .all(termId, lang)
  ) as DecisionRow[];
  return rows.map(fromDecisionRow);
}

// ----------------------------------------------------------- retrieval

/**
 * The current preferred rendering of a term in a language — derived,
 * never stored (smart-glossary-spec.md §3.3): the non-forbidden variant
 * named by the most recent non-deprecation decision; with no decision
 * at all, the earliest non-forbidden variant. Language matching is
 * region-insensitive, like `retrievePair`.
 */
export function preferredVariant(
  db: Database.Database,
  termId: number,
  lang: string,
  options: ReadOptions = {},
): TermVariant | null {
  ensurePrimarySubtagFn(db);
  const s = qualify(options.schema);
  const latestDecision = (column: string): string =>
    `(SELECT MAX(d.${column}) FROM ${s}term_decision d
       WHERE d.term_id = v.term_id
         AND primary_subtag(d.lang) = primary_subtag(v.lang)
         AND d.chosen = v.plain
         AND d.kind <> 'deprecation')`;
  const row = db
    .prepare(
      `SELECT v.* FROM ${s}term_variant v
       WHERE v.term_id = ? AND primary_subtag(v.lang) = primary_subtag(?) AND v.forbidden = 0
       ORDER BY ${latestDecision('decided_at')} DESC NULLS LAST,
                ${latestDecision('id')} DESC NULLS LAST,
                v.id ASC
       LIMIT 1`,
    )
    .get(termId, lang) as VariantRow | undefined;
  return row ? fromVariantRow(row) : null;
}

export interface FindRenderingParams {
  readonly srcLang: string;
  /** Source-language text as it appears; matched by `termKey`. */
  readonly srcText: string;
  readonly tgtLang: string;
}

export interface Rendering {
  readonly termId: number;
  readonly source: TermVariant;
  readonly target: TermVariant;
}

/**
 * Every non-tombstoned term whose source-language variant matches
 * `srcText`, with its preferred target rendering. Direction is not
 * encoded anywhere — ES→EN over an EN→ES-authored glossary is the same
 * call with the languages swapped, exactly as `retrievePair`. Terms with
 * no non-forbidden rendering in `tgtLang` are omitted.
 */
export function findRendering(
  db: Database.Database,
  params: FindRenderingParams,
  options: ReadOptions = {},
): Rendering[] {
  ensurePrimarySubtagFn(db);
  const s = qualify(options.schema);
  const rows = db
    .prepare(
      `SELECT v.* FROM ${s}term_variant v
       JOIN ${s}term t ON t.id = v.term_id AND t.deleted = 0
       WHERE v.lang IN ${matchingLangs(`${s}term_variant`, '@srcLang')} AND v.plain = @plain
       ORDER BY v.term_id, v.id`,
    )
    .all({ srcLang: params.srcLang, plain: termKey(params.srcText) }) as VariantRow[];
  const out: Rendering[] = [];
  const seen = new Set<number>();
  for (const src of rows) {
    if (seen.has(src.term_id)) continue;
    seen.add(src.term_id);
    const target = preferredVariant(db, src.term_id, params.tgtLang, options);
    if (target) out.push({ termId: src.term_id, source: fromVariantRow(src), target });
  }
  return out;
}
