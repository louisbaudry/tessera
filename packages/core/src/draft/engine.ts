/**
 * Which draft engine, if any, may be sent a project's content
 * (`planning/translation-engine-spec.md` D4, D8, D19; backlog #133).
 *
 * The one place the consent rule is written. A client's content leaves for an
 * engine only if that client consented to that very engine, and a project can
 * only narrow what its client allows, never widen it. Pure and headless like
 * the rest of `core`: the settings arrive as arguments, read by `db` from
 * `platform.sqlite` (the client) and the project file (the override), and the
 * server decides what to do with the answer. Nothing here sends anything.
 *
 * The rule fails closed. Every missing input — no client number on the
 * project, no row for the client, an override to an engine nobody consented
 * to, a default that outlived its consent — resolves to `off`, with the reason
 * named so a refusal can be explained rather than guessed at.
 */

/**
 * Every value a setting can hold. A frozen literal in each migration that
 * stores it, never imported into a `schema.ts` (`CLAUDE.md`, the snapshot
 * invariant); `db/check-lists.test.ts` ties the newest snapshot to this list.
 */
export const ENGINE_CHOICES = ['off', 'tessera', 'deepl'] as const;
export type EngineChoice = (typeof ENGINE_CHOICES)[number];

/** The engines that send client content out: the choices other than `off`. */
export const DRAFT_ENGINES = ['tessera', 'deepl'] as const;
export type DraftEngine = (typeof DRAFT_ENGINES)[number];

/** Whether `value` is one of {@link ENGINE_CHOICES}. */
export function isEngineChoice(value: unknown): value is EngineChoice {
  return (ENGINE_CHOICES as readonly unknown[]).includes(value);
}

/** Whether `value` is one of {@link DRAFT_ENGINES}. */
export function isDraftEngine(value: unknown): value is DraftEngine {
  return (DRAFT_ENGINES as readonly unknown[]).includes(value);
}

/**
 * What a client has set. `consented` is per engine, not one flag: consenting
 * to one engine says nothing about another (D19).
 */
export interface ClientEngineSettings {
  /** The engine a project inherits; `off` unless someone chose one. */
  readonly default: EngineChoice;
  /** The engines this client has agreed may be sent its content. */
  readonly consented: readonly DraftEngine[];
}

export interface EngineInputs {
  /** Whether the project names a client at all (`portal_client_setting`). */
  readonly hasClient: boolean;
  /** The client's settings, or `null` when it has none (which is `off`). */
  readonly client: ClientEngineSettings | null;
  /** The project's override, or `null` to inherit the client's default. */
  readonly projectOverride: EngineChoice | null;
}

/** Why the answer is `off`. */
export type EngineOffReason =
  /** The project names no client, so there is nobody to have consented. */
  | 'no_client'
  /** Nothing chose an engine: the client's default is `off`, or it has no row. */
  | 'client_default_off'
  /** The project turned it off. */
  | 'project_off'
  /** The engine asked for, by the project or by a stale default, was never consented to. */
  | 'not_consented';

export type EngineDecision =
  | { readonly engine: DraftEngine }
  | { readonly engine: 'off'; readonly reason: EngineOffReason };

/**
 * The engine a project may use right now, or `off` and why.
 *
 * Order matters and is the rule: no client is `off` before anything else is
 * read; then the wanted engine is the project's override if it has one, else
 * the client's default; `off` stays `off`; and an engine the client has not
 * consented to is `off` however it was asked for. The consent list is checked
 * even for a client's own default, so a default that outlived a withdrawn
 * consent sends nothing.
 */
export function resolveEngine(inputs: EngineInputs): EngineDecision {
  if (!inputs.hasClient) return { engine: 'off', reason: 'no_client' };
  const client = inputs.client;
  const wanted: EngineChoice = inputs.projectOverride ?? client?.default ?? 'off';
  if (wanted === 'off') {
    return {
      engine: 'off',
      reason: inputs.projectOverride === 'off' ? 'project_off' : 'client_default_off',
    };
  }
  if (client === null || !client.consented.includes(wanted)) {
    return { engine: 'off', reason: 'not_consented' };
  }
  return { engine: wanted };
}
