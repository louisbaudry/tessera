/**
 * Who may do what to a project (`planning/vendor-spec.md` §1 decision 2,
 * §3 implementation note; backlog #45). Pure: the closed sets and the one
 * table that says what a scope permits, so the server asks a function and
 * never re-encodes the answer in a route.
 *
 * An owner is not a scope: a project in an account's own storage root is
 * theirs, and `scopeAllows` is only asked about what was granted to someone
 * else. The role classifies an account and permits nothing.
 */

/** `owner` (an owner or PM, the default) or `vendor`. Never a permission. */
export const ACCOUNT_ROLES = ['owner', 'vendor'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** What an owner can grant another account on a project. A reviewer scope is Ring 1. */
export const PROJECT_SCOPES = ['assigned_translator'] as const;
export type ProjectScope = (typeof PROJECT_SCOPES)[number];

/**
 * What a route asks for: `read` the project, its files, segments and QA
 * findings; `edit` them (save, confirm, split, merge, dismiss a finding);
 * `manage` everything else (settings, memories, glossaries, files, export,
 * pre-translate, delete).
 */
export const PROJECT_ACTIONS = ['read', 'edit', 'manage'] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

/** A `Record` over the scope union, so a new scope fails typecheck until it says what it permits. */
const PERMITTED: Readonly<Record<ProjectScope, readonly ProjectAction[]>> = {
  assigned_translator: ['read', 'edit'],
};

/** Whether a grant of `scope` lets its holder do `action`. */
export function scopeAllows(scope: ProjectScope, action: ProjectAction): boolean {
  return PERMITTED[scope].includes(action);
}

export const isProjectScope = (value: unknown): value is ProjectScope =>
  (PROJECT_SCOPES as readonly unknown[]).includes(value);
