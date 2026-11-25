/**
 * What the owner's AI spend screen says about a row (issue #150): the engine, the units
 * and what became of the replies. Pure, so it is proved in node. A row is a sum the
 * server made over `ai_usage`: units only, never text, and **no price** (Tessera holds none,
 * `core/draft/usage.ts`), so the screen never writes a currency.
 */
import type { AiUsageUnit, DraftEngine } from '@cat-tool/core';

/** One row of `GET /api/ai-spend`: the sums for an engine, a model and a unit. */
export interface SpendRow {
  readonly engine: DraftEngine;
  readonly model: string;
  readonly unit: AiUsageUnit;
  readonly calls: number;
  readonly inputUnits: number;
  readonly outputUnits: number;
  readonly stored: number;
  readonly rejected: number;
  readonly discarded: number;
}

/** The sums for a set of rows: one project's, or the tenant's. */
export interface SpendUsage {
  readonly rows: SpendRow[];
  readonly calls: number;
}

/** `GET /api/ai-spend`: the projects that spent something, and the tenant's total. */
export interface SpendView {
  readonly projects: Array<{ name: string; usage: SpendUsage }>;
  readonly total: SpendUsage;
}

const grouped = new Intl.NumberFormat('en-US');

/** A `Record` over core's engines, so a new engine fails this typecheck until it is worded here. */
const ENGINE_NAME: Record<DraftEngine, (model: string) => string> = {
  tessera: (model) => `Tessera engine (${model})`,
  // DeepL has one model name that tells the owner nothing the engine's name does not.
  deepl: () => 'DeepL',
};

/** The engine as the owner knows it, with the model where the model is a choice. */
export function engineLabel(engine: DraftEngine, model: string): string {
  return ENGINE_NAME[engine](model);
}

/**
 * The counts of a row in its own unit: tokens in and out, or one count of characters
 * (DeepL bills the source's characters and reports no output).
 */
export function unitsLabel(
  row: Pick<SpendRow, 'unit' | 'inputUnits' | 'outputUnits'>,
): string {
  if (row.unit === 'characters') return `${grouped.format(row.inputUnits)} characters`;
  return `${grouped.format(row.inputUnits)} in, ${grouped.format(row.outputUnits)} out tokens`;
}

/**
 * How the replies fared: "8 of 10 kept", then what was paid for and not kept. A refused
 * reply failed `validateDraft`; a dropped one landed after the client withdrew consent.
 */
export function outcomeSummary(row: SpendRow): string {
  const parts = [`${row.stored} of ${row.calls} kept`];
  if (row.rejected > 0) parts.push(`${row.rejected} refused`);
  if (row.discarded > 0) parts.push(`${row.discarded} dropped`);
  return parts.join(', ');
}

/** One reply of `GET /api/projects/:name/ai-calls`: a row of the record, units and ids only. */
export interface CallRow {
  readonly id: number;
  readonly segmentId: number;
  readonly engine: DraftEngine;
  readonly model: string;
  readonly unit: AiUsageUnit;
  readonly inputUnits: number;
  readonly outputUnits: number;
  readonly outcome: 'stored' | 'rejected' | 'discarded';
  /** ISO timestamp of the reply. */
  readonly at: string;
}

/** A page of the per-call log, newest first; `next` is the cursor of the older page. */
export interface CallPage {
  readonly calls: CallRow[];
  readonly next: number | null;
}

/** A `Record` over the outcomes, so one added to the record fails this typecheck. */
const OUTCOME_WORD: Record<CallRow['outcome'], string> = {
  stored: 'Kept',
  rejected: 'Refused',
  discarded: 'Dropped',
};

/** What became of one reply, as the summary's words name it. */
export function callOutcome(outcome: CallRow['outcome']): string {
  return OUTCOME_WORD[outcome];
}

/**
 * When a reply came back, to the minute, in UTC so two admins reading one log see one
 * time (`2026-11-01 14:05 UTC`). An unreadable stamp is shown as it is rather than hidden.
 */
export function callTime(at: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(at);
  return match ? `${match[1]} ${match[2]} UTC` : at;
}

/** Appends an older page to what is shown, dropping any row already there (a repeated load). */
export function appendPage(shown: readonly CallRow[], page: CallPage): CallRow[] {
  const seen = new Set(shown.map((c) => c.id));
  return [...shown, ...page.calls.filter((c) => !seen.has(c.id))];
}
