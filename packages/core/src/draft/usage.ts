/**
 * What a draft engine's reply cost, in the engine's own units (issue #150,
 * `planning/translation-engine-spec.md`, the #150 note). Pure vocabulary: the
 * `.catdb` stores the rows (`db/project/ai-usage.ts`), this names the closed sets
 * and which unit an engine is counted in.
 *
 * **There is no money here.** A price changes by model and by date and Tessera
 * holds none; the view reports units, and an owner with a price list multiplies.
 */

import type { DraftEngine } from './engine.js';

/**
 * How a reply is counted. Frozen as a literal in the migration that creates
 * `ai_usage.unit`; `db/check-lists.test.ts` ties the newest snapshot to this list.
 */
export const AI_USAGE_UNITS = ['tokens', 'characters'] as const;
export type AiUsageUnit = (typeof AI_USAGE_UNITS)[number];

/**
 * What became of a reply that was paid for: kept as a suggestion, refused by
 * `validateDraft`, or dropped because the client withdrew consent while the
 * call was out. A reply that never came back (a network error) has no row.
 */
export const AI_USAGE_OUTCOMES = ['stored', 'rejected', 'discarded'] as const;
export type AiUsageOutcome = (typeof AI_USAGE_OUTCOMES)[number];

/**
 * The unit an engine's {@link DraftUsage} is in. DeepL bills by source
 * character and reports no tokens, so its adapter reports characters in the
 * same field (the run's ceiling counts them too, spec D40); Anthropic reports
 * tokens. A new engine states its unit here, never in a route.
 */
export function usageUnit(engine: DraftEngine): AiUsageUnit {
  return engine === 'deepl' ? 'characters' : 'tokens';
}
