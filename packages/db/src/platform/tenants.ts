/**
 * `tenant` and `tenant_membership` repository (backlog #204,
 * `planning/tenant-spec.md` D1, D2, D4, D9).
 *
 * A tenant is one customer LSP: the organisation that owns a storage root, a
 * vendor roster, its clients' consents and its project grants. Staff belong to
 * one tenant through a membership; a vendor is never staff (D3, enforced by the
 * schema's trigger, not here). Nothing in the server reads these tables yet —
 * slice 2 (#205) moves the readers from the owner account to the tenant — so
 * this module is the write side and the lookups slice 2 will call.
 *
 * The tenant's `storage_root` is its founding admin's account root, copied once
 * (D4): until the readers move, every file is still under that directory, so the
 * tenant has to name exactly it. It is minted by `createAccount`, never chosen by a
 * caller. The name is a company's and is data, never repo content (D12): it is
 * typed at the command line, and no audit detail carries it.
 *
 * Every write records its `audit_event` in the same transaction, with a required
 * actor (`audit-spec.md` §2.5).
 */

import { isTenantRole, type AuditActor, type TenantRole } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';

export interface Tenant {
  readonly id: number;
  /** The LSP's display name: typed by the operator, never in a log detail. */
  readonly name: string;
  /** Relative to the server's storage volume, e.g. `u/3f9a2c…` (D4). */
  readonly storageRoot: string;
  readonly createdAt: string;
}

/** A refused tenant write: a bad name or an unknown tenant. */
export class TenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantError';
  }
}

/** Long enough for any company's name, short enough to fit a header. */
export const MAX_TENANT_NAME_LENGTH = 120;

/** Control characters, written as escapes so no editor can mangle the class. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A tenant's display name as stored: trimmed, 1 to 120 characters, no control
 * character (a newline in a name would split a log line and a CSV row).
 *
 * @throws {TenantError} for an empty, overlong or control-bearing name.
 */
export function normaliseTenantName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new TenantError('a tenant needs a name');
  if (trimmed.length > MAX_TENANT_NAME_LENGTH) {
    throw new TenantError(
      `a tenant's name is at most ${MAX_TENANT_NAME_LENGTH} characters`,
    );
  }
  if (CONTROL.test(trimmed)) {
    throw new TenantError("a tenant's name has no control characters");
  }
  return trimmed;
}

interface TenantRow {
  id: number;
  name: string;
  storage_root: string;
  created_at: string;
}

const fromRow = (row: TenantRow): Tenant => ({
  id: row.id,
  name: row.name,
  storageRoot: row.storage_root,
  createdAt: row.created_at,
});

export function getTenantById(db: Database.Database, id: number): Tenant | null {
  const row = db.prepare('SELECT * FROM tenant WHERE id = ?').get(id) as
    TenantRow | undefined;
  return row ? fromRow(row) : null;
}

/** Every tenant, in creation order. */
export function listTenants(db: Database.Database): Tenant[] {
  return (db.prepare('SELECT * FROM tenant ORDER BY id').all() as TenantRow[]).map(
    fromRow,
  );
}

export interface TenantMembership {
  readonly tenant: Tenant;
  readonly role: TenantRole;
}

/**
 * The tenant an account is staff of, and its role there; `null` for a vendor and
 * for an account that does not exist. At most one (v1, D2): the membership is
 * unique per account.
 */
export function getTenantForAccount(
  db: Database.Database,
  accountId: number,
): TenantMembership | null {
  const row = db
    .prepare(
      `SELECT t.id, t.name, t.storage_root, t.created_at, m.role
       FROM tenant_membership m JOIN tenant t ON t.id = m.tenant_id
       WHERE m.account_id = ?`,
    )
    .get(accountId) as (TenantRow & { role: string }) | undefined;
  if (!row) return null;
  if (!isTenantRole(row.role)) {
    // The CHECK makes this unreachable; failing loudly beats a role nobody declared.
    throw new TenantError(`tenant membership has an unknown role "${row.role}"`);
  }
  return { tenant: fromRow(row), role: row.role };
}

export interface InsertTenantOptions {
  /** A display name, or omit for `Tenant <id>` until the operator renames it. */
  readonly name?: string;
  /** The founding admin's account root, which the tenant takes over (D4). */
  readonly storageRoot: string;
  readonly adminAccountId: number;
  readonly now: string;
  readonly actor: AuditActor;
}

/**
 * Writes a tenant, its first admin's membership and `tenant.created`. Runs inside
 * the caller's transaction: it is the second half of creating an owner account
 * (`createAccount`), never a write of its own, so there is no tenant without an
 * admin and no owner without a tenant. Not exported from the package.
 *
 * @throws {TenantError} for a bad name.
 */
export function insertTenant(
  db: Database.Database,
  options: InsertTenantOptions,
): Tenant {
  const given = options.name === undefined ? null : normaliseTenantName(options.name);
  // Named `Tenant <id>` after the insert when none is given, as the migration does:
  // the id is not known until the row exists.
  const info = db
    .prepare('INSERT INTO tenant (name, storage_root, created_at) VALUES (?, ?, ?)')
    .run(given ?? 'Tenant', options.storageRoot, options.now);
  const id = info.lastInsertRowid as number;
  if (given === null)
    db.prepare('UPDATE tenant SET name = ? WHERE id = ?').run(`Tenant ${id}`, id);
  db.prepare(
    "INSERT INTO tenant_membership (tenant_id, account_id, role, added_at) VALUES (?, ?, 'admin', ?)",
  ).run(id, options.adminAccountId, options.now);
  appendAuditEvent(db, {
    actor: options.actor,
    action: 'tenant.created',
    subjectType: 'tenant',
    subjectId: String(id),
    detail: null,
  });
  return {
    id,
    name: given ?? `Tenant ${id}`,
    storageRoot: options.storageRoot,
    createdAt: options.now,
  };
}

export interface RenameTenantOptions {
  readonly tenantId: number;
  readonly name: string;
  /** Who renamed it — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

/**
 * Sets a tenant's display name and logs `tenant.renamed`, with neither name in the
 * event (a detail is hashed; erasure could never reach a company's name). Naming the
 * same name again changes and logs nothing. How the first tenant gets its real name
 * without it entering the repo (D12).
 *
 * @throws {TenantError} for an unknown tenant or a bad name; nothing is written.
 */
export function renameTenant(
  db: Database.Database,
  options: RenameTenantOptions,
): Tenant {
  const name = normaliseTenantName(options.name);
  return db.transaction((): Tenant => {
    const current = getTenantById(db, options.tenantId);
    if (!current) throw new TenantError(`no tenant #${options.tenantId}`);
    if (current.name === name) return current;
    db.prepare('UPDATE tenant SET name = ? WHERE id = ?').run(name, current.id);
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'tenant.renamed',
      subjectType: 'tenant',
      subjectId: String(current.id),
      detail: null,
    });
    return { ...current, name };
  })();
}
