/**
 * The suggestion store (backlog #135; `planning/translation-engine-spec.md` D5,
 * `audit-spec.md` §4): a draft engine's output, held **outside the segment**
 * until a person accepts it. Nothing here writes `segment.target_tokens`, so an
 * unaccepted draft never reaches an export, a QA pass or a memory.
 *
 * Storing a suggestion logs nothing of its own: the event that matters is the
 * text leaving, `ai.requested`, which `draftSuggestions` writes before the send.
 * Acceptance is the write (`segment.target_set` with this row's provenance, the
 * accepting person as actor), and belongs to the editor slice.
 *
 * A row is for one version of the source: `source_hash` is the segment's own
 * when it was drafted, and a read returns it only while the segment still has
 * that hash. A restructure that changes the source makes the suggestion
 * invisible rather than wrong.
 */

import type { DraftEngine, Token } from '@cat-tool/core';
import type Database from 'better-sqlite3';

/** What a stored suggestion is: the draft, and what accepting it will record. */
export interface DraftSuggestion {
  readonly segmentId: number;
  readonly sourceHash: string;
  /** Visible tags only; the hidden ones are carried when it is accepted. */
  readonly targetTokens: readonly Token[];
  readonly engine: DraftEngine;
  readonly model: string;
  readonly promptVersion: string;
  /** SHA-256 of the prompt it was made from; the prompt itself is never stored. */
  readonly inputSha256: string;
  readonly createdAt: string;
}

interface Row {
  segment_id: number;
  source_hash: string;
  target_tokens: string;
  engine: DraftEngine;
  model: string;
  prompt_version: string;
  input_sha256: string;
  created_at: string;
}

const fromRow = (row: Row): DraftSuggestion => ({
  segmentId: row.segment_id,
  sourceHash: row.source_hash,
  targetTokens: JSON.parse(row.target_tokens) as Token[],
  engine: row.engine,
  model: row.model,
  promptVersion: row.prompt_version,
  inputSha256: row.input_sha256,
  createdAt: row.created_at,
});

/** The segment's suggestion if it was made for the segment's current source, else `null`. */
export function getDraftSuggestion(
  db: Database.Database,
  segmentId: number,
): DraftSuggestion | null {
  const row = db
    .prepare(
      `SELECT d.* FROM draft_suggestion d
       JOIN segment s ON s.id = d.segment_id AND s.source_hash = d.source_hash
       WHERE d.segment_id = ?`,
    )
    .get(segmentId) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Every current suggestion, in segment order. */
export function listDraftSuggestions(db: Database.Database): DraftSuggestion[] {
  return (
    db
      .prepare(
        `SELECT d.* FROM draft_suggestion d
         JOIN segment s ON s.id = d.segment_id AND s.source_hash = d.source_hash
         ORDER BY s.file_id, s.ord`,
      )
      .all() as Row[]
  ).map(fromRow);
}

/**
 * Stores a suggestion for a segment, replacing any earlier one (a new draft
 * supersedes the old). `createdAt` is the caller's clock reading, so the
 * store has none.
 */
export function putDraftSuggestion(db: Database.Database, s: DraftSuggestion): void {
  db.prepare(
    `INSERT INTO draft_suggestion
       (segment_id, source_hash, target_tokens, engine, model, prompt_version,
        input_sha256, created_at)
     VALUES (@segment_id, @source_hash, @target_tokens, @engine, @model,
             @prompt_version, @input_sha256, @created_at)
     ON CONFLICT (segment_id) DO UPDATE SET
       source_hash = excluded.source_hash,
       target_tokens = excluded.target_tokens,
       engine = excluded.engine,
       model = excluded.model,
       prompt_version = excluded.prompt_version,
       input_sha256 = excluded.input_sha256,
       created_at = excluded.created_at`,
  ).run({
    segment_id: s.segmentId,
    source_hash: s.sourceHash,
    target_tokens: JSON.stringify(s.targetTokens),
    engine: s.engine,
    model: s.model,
    prompt_version: s.promptVersion,
    input_sha256: s.inputSha256,
    created_at: s.createdAt,
  });
}

/** Removes a segment's suggestion; returns whether there was one. */
export function deleteDraftSuggestion(db: Database.Database, segmentId: number): boolean {
  return (
    db.prepare('DELETE FROM draft_suggestion WHERE segment_id = ?').run(segmentId)
      .changes > 0
  );
}
