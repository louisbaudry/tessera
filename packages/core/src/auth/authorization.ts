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

/**
 * What a member of a tenant is there (`planning/tenant-spec.md` D2, D5): `admin`
 * (everything, including staff, engine consent, webhooks) or `pm` (projects,
 * memories, roster, assignments). Staff only: a vendor is never tenant staff
 * (D3), so there is no vendor role here and `tenant_membership` refuses one.
 * What each may do is `tenantRoleAllows` below, the one table a route asks.
 */
export const TENANT_ROLES = ['admin', 'pm'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/**
 * What a route asks a staff role about (`planning/tenant-spec.md` D5): `work` is
 * everything a PM does (projects, memories, glossaries, the roster, assignments, payables),
 * and the rest govern the tenant itself: who is staff and in which role, which engines a
 * client consents to, and where webhooks go.
 */
export const TENANT_ACTIONS = ['work', 'staff', 'consent', 'webhooks'] as const;
export type TenantAction = (typeof TENANT_ACTIONS)[number];

/** A `Record` over the role union, so a new role fails typecheck until it says what it may do. */
const TENANT_PERMITTED: Readonly<Record<TenantRole, readonly TenantAction[]>> = {
  admin: ['work', 'staff', 'consent', 'webhooks'],
  pm: ['work'],
};

/** Whether a staff member of `role` may do `action`. Pure: the server asks, a route never re-encodes. */
export function tenantRoleAllows(role: TenantRole, action: TenantAction): boolean {
  return TENANT_PERMITTED[role].includes(action);
}

export const isTenantRole = (value: unknown): value is TenantRole =>
  (TENANT_ROLES as readonly unknown[]).includes(value);

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
