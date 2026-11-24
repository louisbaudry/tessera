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
export function unitsLabel(row: SpendRow): string {
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
