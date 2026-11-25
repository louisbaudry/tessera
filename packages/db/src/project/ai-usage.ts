/**
 * What a project's draft runs spent (issue #150, `translation-engine-spec.md`, the #150
 * note): one `ai_usage` row per reply an engine sent back, and the sum an owner reads.
 *
 * Units only. A row holds the engine, the model the engine reported, the unit it is
 * counted in (`usageUnit`), the input and output counts, what became of the reply and
 * when. It never holds a prompt, a reply or a source (that would be client content a second
 * time, in a file the owner can export), and it has no price (`core/draft/usage.ts`).
 * The record is written in the run's own flow (`draft.ts`), not an audit event: the
 * call itself is already `ai.requested`, logged before the send.
 */

import type { AiUsageOutcome, AiUsageUnit, DraftEngine } from '@cat-tool/core';
import type Database from 'better-sqlite3';

/** One reply's cost, as `draftSuggestions` records it. */
export interface AiUsageEntry {
  readonly segmentId: number;
  readonly engine: DraftEngine;
  /** The exact model id the engine reported. */
  readonly model: string;
  readonly unit: AiUsageUnit;
  readonly inputUnits: number;
  readonly outputUnits: number;
  readonly outcome: AiUsageOutcome;
  /** ISO timestamp of the reply. */
  readonly at: string;
}

/** Appends one row. Throws on a negative or non-integer count (the schema's CHECK). */
export function recordAiUsage(db: Database.Database, entry: AiUsageEntry): void {
  db.prepare(
    `INSERT INTO ai_usage
       (segment_id, engine, model, unit, input_units, output_units, outcome, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.segmentId,
    entry.engine,
    entry.model,
    entry.unit,
    entry.inputUnits,
    entry.outputUnits,
    entry.outcome,
    entry.at,
  );
}

/** The sums for one engine and model, in one unit. */
export interface AiUsageRow {
  readonly engine: DraftEngine;
  readonly model: string;
  readonly unit: AiUsageUnit;
  /** Replies paid for. */
  readonly calls: number;
  readonly inputUnits: number;
  readonly outputUnits: number;
  /** Of those replies: kept as a suggestion. */
  readonly stored: number;
  /** Refused by `validateDraft`: paid for and thrown away. */
  readonly rejected: number;
  /** Dropped because the client withdrew consent while the call was out. */
  readonly discarded: number;
}

/** A project's spend: a row per engine, model and unit, and the total replies. */
export interface AiUsage {
  readonly rows: readonly AiUsageRow[];
  readonly calls: number;
}

/**
 * The project's spend, summed in SQL over the append-only rows, ordered engine then
 * model. A unit is part of the grouping, so a model whose adapter changed its unit
 * is two rows and never one meaningless sum. Empty for a project nothing was drafted in.
 */
export function readAiUsage(db: Database.Database): AiUsage {
  const rows = (
    db
      .prepare(
        `SELECT engine, model, unit,
                COUNT(*)                                          AS calls,
                SUM(input_units)                                  AS input_units,
                SUM(output_units)                                 AS output_units,
                SUM(CASE WHEN outcome = 'stored'    THEN 1 ELSE 0 END) AS stored,
                SUM(CASE WHEN outcome = 'rejected'  THEN 1 ELSE 0 END) AS rejected,
                SUM(CASE WHEN outcome = 'discarded' THEN 1 ELSE 0 END) AS discarded
           FROM ai_usage
          GROUP BY engine, model, unit
          ORDER BY engine, model, unit`,
      )
      .all() as Array<{
      engine: DraftEngine;
      model: string;
      unit: AiUsageUnit;
      calls: number;
      input_units: number;
      output_units: number;
      stored: number;
      rejected: number;
      discarded: number;
    }>
  ).map((r): AiUsageRow => ({
    engine: r.engine,
    model: r.model,
    unit: r.unit,
    calls: r.calls,
    inputUnits: r.input_units,
    outputUnits: r.output_units,
    stored: r.stored,
    rejected: r.rejected,
    discarded: r.discarded,
  }));
  return { rows, calls: rows.reduce((n, r) => n + r.calls, 0) };
}

/**
 * Several projects' spend added together (the owner's total): rows with the same engine,
 * model and unit merge, anything else stays apart, so characters never mix into tokens.
 * Pure: it reads no file.
 */
export function sumAiUsage(usages: readonly AiUsage[]): AiUsage {
  const merged = new Map<string, AiUsageRow>();
  for (const usage of usages) {
    for (const row of usage.rows) {
      const key = `${row.engine}\u0000${row.model}\u0000${row.unit}`;
      const have = merged.get(key);
      merged.set(
        key,
        have === undefined
          ? row
          : {
              ...row,
              calls: have.calls + row.calls,
              inputUnits: have.inputUnits + row.inputUnits,
              outputUnits: have.outputUnits + row.outputUnits,
              stored: have.stored + row.stored,
              rejected: have.rejected + row.rejected,
              discarded: have.discarded + row.discarded,
            },
      );
    }
  }
  const rows = [...merged.values()].sort(
    (a, b) =>
      a.engine.localeCompare(b.engine) ||
      a.model.localeCompare(b.model) ||
      a.unit.localeCompare(b.unit),
  );
  return { rows, calls: rows.reduce((n, r) => n + r.calls, 0) };
}

/** One reply as the per-call log shows it: a row of `ai_usage`, nothing added. */
export interface AiCall extends AiUsageEntry {
  /** The row's id, the log's cursor. */
  readonly id: number;
}

/** A page of the per-call log, newest first, and the cursor for the page after it. */
export interface AiCallPage {
  readonly calls: readonly AiCall[];
  /** Pass as `before` for the next (older) page; null when this page is the last. */
  readonly next: number | null;
}

/** The most rows one page of the log holds, whatever a caller asks for. */
export const AI_CALL_PAGE_MAX = 200;

/**
 * The per-call log (issue #150's remainder): the project's `ai_usage` rows, newest first,
 * `limit` at a time (clamped to 1..`AI_CALL_PAGE_MAX`), each older than the row `before`
 * names when it is given. Keyed on the row id, the table's primary key, so a page is a
 * seek and never a scan, and a row appended while someone pages never shifts a page they
 * have not read yet. The rows carry what they always did: units, outcome, the segment's id
 * and the engine's model, never text.
 */
export function listAiCalls(
  db: Database.Database,
  params: { readonly before?: number; readonly limit: number },
): AiCallPage {
  const limit = Math.min(AI_CALL_PAGE_MAX, Math.max(1, Math.trunc(params.limit)));
  // One row more than the page, to know whether another page exists without a COUNT.
  const rows = db
    .prepare(
      `SELECT id, segment_id, engine, model, unit, input_units, output_units, outcome, at
         FROM ai_usage
        WHERE id < @before
        ORDER BY id DESC
        LIMIT @take`,
    )
    .all({ before: params.before ?? Number.MAX_SAFE_INTEGER, take: limit + 1 }) as Array<{
    id: number;
    segment_id: number;
    engine: DraftEngine;
    model: string;
    unit: AiUsageUnit;
    input_units: number;
    output_units: number;
    outcome: AiUsageOutcome;
    at: string;
  }>;
  const page = rows.slice(0, limit).map((r): AiCall => ({
    id: r.id,
    segmentId: r.segment_id,
    engine: r.engine,
    model: r.model,
    unit: r.unit,
    inputUnits: r.input_units,
    outputUnits: r.output_units,
    outcome: r.outcome,
    at: r.at,
  }));
  return { calls: page, next: rows.length > limit ? page[page.length - 1]!.id : null };
}
