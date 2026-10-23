/**
 * Provisioning a tenant from the command line (backlog #204,
 * `planning/tenant-spec.md` D7): the operator makes the customer LSP and its first
 * admin in one write. There is no signup route and no plan: the first tenant is a
 * company the owner already runs, provisioned by hand (D12, O4).
 *
 * Its own module because it needs both `createAccount` (which makes the owner's
 * tenant) and the tenant lookups, and `accounts.ts` already imports `tenants.ts`.
 */

import type { AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { createAccount, type Account } from './accounts.js';
import { getTenantForAccount, TenantError, type Tenant } from './tenants.js';

export interface CreateTenantOptions {
  /** The LSP's display name, data and never repo content (D12). */
  readonly name: string;
  /** The first admin's email: a new owner account is created for it. */
  readonly email: string;
  /** From `hashPassword` — never a raw password. */
  readonly passwordHash: string;
  /** Who created it — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

/**
 * Creates a tenant and its first admin: a new `owner` account whose storage root the
 * tenant takes over, an `admin` membership, `account.created` and `tenant.created`,
 * in one transaction. Nothing is written when the name or the email is refused.
 *
 * @throws {TenantError} for a bad name.
 * @throws when the email already has an account (the `account.email` UNIQUE).
 */
export function createTenant(
  db: Database.Database,
  options: CreateTenantOptions,
): { readonly tenant: Tenant; readonly account: Account } {
  return db.transaction(() => {
    const account = createAccount(db, {
      email: options.email,
      passwordHash: options.passwordHash,
      actor: options.actor,
      tenantName: options.name,
    });
    const found = getTenantForAccount(db, account.id);
    if (!found) throw new TenantError('an owner account was created without a tenant');
    return { tenant: found.tenant, account };
  })();
}
