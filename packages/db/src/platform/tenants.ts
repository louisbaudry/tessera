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

import {
  isTenantRole,
  tenantSlugProblem,
  type AuditActor,
  type TenantRole,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendPlatformEvent } from './audit-write.js';

export interface Tenant {
  readonly id: number;
  /** The LSP's display name: typed by the operator, never in a log detail. */
  readonly name: string;
  /** Relative to the server's storage volume, e.g. `u/3f9a2c…` (D4). */
  readonly storageRoot: string;
  /**
   * The public name its address is built from (`<slug>.<base domain>`, D14), set once by the
   * operator; `null` until then. A company's name in effect, so like `name` it is data and in
   * no log detail.
   */
  readonly slug: string | null;
  readonly createdAt: string;
}

/** A refused tenant write: a bad name or an unknown tenant. */
export class TenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantError';
  }
}

/** The tenant has no such member: a stranger's account and a missing one read the same. */
export class NoSuchMemberError extends TenantError {
  constructor() {
    super('no such member on this tenant');
    this.name = 'NoSuchMemberError';
  }
}

/** The write would leave a tenant with no admin (spec §6, invariant 4). */
export class LastAdminError extends TenantError {
  constructor() {
    super('a tenant keeps at least one admin');
    this.name = 'LastAdminError';
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
  slug: string | null;
  created_at: string;
}

const fromRow = (row: TenantRow): Tenant => ({
  id: row.id,
  name: row.name,
  storageRoot: row.storage_root,
  slug: row.slug,
  createdAt: row.created_at,
});

export function getTenantById(db: Database.Database, id: number): Tenant | null {
  const row = db.prepare('SELECT * FROM tenant WHERE id = ?').get(id) as
    TenantRow | undefined;
  return row ? fromRow(row) : null;
}

/** The tenant that holds `slug`, or `null`: how a host is turned into a tenant (D14). */
export function getTenantBySlug(db: Database.Database, slug: string): Tenant | null {
  const row = db.prepare('SELECT * FROM tenant WHERE slug = ?').get(slug) as
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
      `SELECT t.id, t.name, t.storage_root, t.slug, t.created_at, m.role
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
  appendPlatformEvent(db, {
    actor: options.actor,
    action: 'tenant.created',
    tenantId: id,
    subjectType: 'tenant',
    subjectId: String(id),
    detail: null,
  });
  return {
    id,
    name: given ?? `Tenant ${id}`,
    storageRoot: options.storageRoot,
    slug: null,
    createdAt: options.now,
  };
}

export interface TenantStaffMember {
  readonly accountId: number;
  readonly email: string;
  readonly role: TenantRole;
  readonly addedAt: string;
}

/**
 * A tenant's staff in the order they joined (account ids rise with joining, and an
 * `added_at` can be older than the account when a migration backfilled it).
 */
export function listTenantStaff(
  db: Database.Database,
  tenantId: number,
): TenantStaffMember[] {
  const rows = db
    .prepare(
      `SELECT m.account_id AS accountId, a.email, m.role, m.added_at AS addedAt
       FROM tenant_membership m JOIN account a ON a.id = m.account_id
       WHERE m.tenant_id = ? ORDER BY m.account_id`,
    )
    .all(tenantId) as Array<Omit<TenantStaffMember, 'role'> & { role: string }>;
  return rows.map((row) => {
    if (!isTenantRole(row.role)) {
      throw new TenantError(`tenant membership has an unknown role "${row.role}"`);
    }
    return { ...row, role: row.role };
  });
}

export interface AddTenantMemberOptions {
  readonly tenantId: number;
  readonly accountId: number;
  readonly role: TenantRole;
  readonly now: string;
  readonly actor: AuditActor;
}

/**
 * Puts an existing owner account on a tenant's staff and logs `tenant.member_added`.
 * Runs inside the caller's transaction (`createAccount`'s `joinTenant`, a staff link
 * accepted): there is no route that adds a member on its own. A vendor, a second
 * tenant for the same account and a role outside the list are all refused by the
 * schema's triggers and CHECKs; the unknown tenant is refused here.
 *
 * @throws {TenantError} for an unknown tenant or role.
 */
export function addTenantMember(
  db: Database.Database,
  options: AddTenantMemberOptions,
): void {
  if (!isTenantRole(options.role))
    throw new TenantError(`unknown role "${options.role}"`);
  if (!getTenantById(db, options.tenantId)) {
    throw new TenantError(`no tenant #${options.tenantId}`);
  }
  db.prepare(
    'INSERT INTO tenant_membership (tenant_id, account_id, role, added_at) VALUES (?, ?, ?, ?)',
  ).run(options.tenantId, options.accountId, options.role, options.now);
  appendPlatformEvent(db, {
    actor: options.actor,
    action: 'tenant.member_added',
    tenantId: options.tenantId,
    subjectType: 'tenant',
    subjectId: String(options.tenantId),
    detail: { account_id: options.accountId, role: options.role },
  });
}

function memberRole(
  db: Database.Database,
  tenantId: number,
  accountId: number,
): TenantRole {
  const row = db
    .prepare('SELECT role FROM tenant_membership WHERE tenant_id = ? AND account_id = ?')
    .get(tenantId, accountId) as { role: string } | undefined;
  // A stranger's account and a missing one read the same.
  if (!row || !isTenantRole(row.role)) throw new NoSuchMemberError();
  return row.role;
}

function adminCount(db: Database.Database, tenantId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM tenant_membership WHERE tenant_id = ? AND role = 'admin'",
      )
      .get(tenantId) as { n: number }
  ).n;
}

export interface ChangeTenantRoleOptions {
  readonly tenantId: number;
  readonly accountId: number;
  readonly role: TenantRole;
  readonly actor: AuditActor;
}

/**
 * Sets a staff member's role and logs `tenant.role_changed` with both roles. The
 * same role again writes nothing. Demoting the last admin is refused here and, as a
 * backstop for any other writer, by a trigger (spec §6, invariant 4).
 *
 * @throws {TenantError} for an unknown role; its `NoSuchMemberError` for a member the
 *   tenant does not have (another tenant's staff included) and `LastAdminError` for
 *   the last admin.
 */
export function changeTenantRole(
  db: Database.Database,
  options: ChangeTenantRoleOptions,
): void {
  if (!isTenantRole(options.role))
    throw new TenantError(`unknown role "${options.role}"`);
  db.transaction(() => {
    const from = memberRole(db, options.tenantId, options.accountId);
    if (from === options.role) return;
    if (from === 'admin' && adminCount(db, options.tenantId) === 1) {
      throw new LastAdminError();
    }
    db.prepare(
      'UPDATE tenant_membership SET role = ? WHERE tenant_id = ? AND account_id = ?',
    ).run(options.role, options.tenantId, options.accountId);
    appendPlatformEvent(db, {
      actor: options.actor,
      action: 'tenant.role_changed',
      tenantId: options.tenantId,
      subjectType: 'tenant',
      subjectId: String(options.tenantId),
      detail: { account_id: options.accountId, from, to: options.role },
    });
  }).immediate();
}

export interface RemoveTenantStaffOptions {
  readonly tenantId: number;
  readonly accountId: number;
  readonly actor: AuditActor;
}

/**
 * Takes someone off a tenant's staff, ends their sessions in the same transaction (a
 * removed person must not stay signed in) and logs `tenant.member_removed`. The
 * account itself stays, tenantless: offboarding it is not built (tenant-spec.md §9).
 *
 * @throws {NoSuchMemberError} for a member the tenant does not have.
 * @throws {LastAdminError} for the tenant's last admin.
 */
export function removeTenantStaff(
  db: Database.Database,
  options: RemoveTenantStaffOptions,
): void {
  db.transaction(() => {
    const role = memberRole(db, options.tenantId, options.accountId);
    if (role === 'admin' && adminCount(db, options.tenantId) === 1) {
      throw new LastAdminError();
    }
    db.prepare('DELETE FROM account_session WHERE account_id = ?').run(options.accountId);
    db.prepare(
      'DELETE FROM tenant_membership WHERE tenant_id = ? AND account_id = ?',
    ).run(options.tenantId, options.accountId);
    appendPlatformEvent(db, {
      actor: options.actor,
      action: 'tenant.member_removed',
      tenantId: options.tenantId,
      subjectType: 'tenant',
      subjectId: String(options.tenantId),
      detail: { account_id: options.accountId },
    });
  }).immediate();
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
    appendPlatformEvent(db, {
      actor: options.actor,
      action: 'tenant.renamed',
      tenantId: current.id,
      subjectType: 'tenant',
      subjectId: String(current.id),
      detail: null,
    });
    return { ...current, name };
  })();
}

export interface SetTenantSlugOptions {
  readonly tenantId: number;
  readonly slug: string;
  /** The operator: required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

/**
 * Sets a tenant's slug and logs `tenant.slug_set` (no slug in the event). **Once**: a slug is in
 * every link and certificate already sent, so changing one would break them and needs a redirect rule
 * nobody has designed (`tenant-spec.md` D14); the same slug again changes and logs nothing.
 *
 * @throws {TenantError} for an unknown tenant, a slug that is not a label or that the platform keeps,
 *   one another tenant holds, or a tenant that already has a different one.
 */
export function setTenantSlug(
  db: Database.Database,
  options: SetTenantSlugOptions,
): Tenant {
  const problem = tenantSlugProblem(options.slug);
  if (problem !== null) throw new TenantError(problem);
  return db
    .transaction((): Tenant => {
      const current = getTenantById(db, options.tenantId);
      if (!current) throw new TenantError(`no tenant #${options.tenantId}`);
      if (current.slug === options.slug) return current;
      if (current.slug !== null) {
        throw new TenantError(
          "the tenant's slug is set and is not changed: its links and certificate carry it",
        );
      }
      const taken = getTenantBySlug(db, options.slug);
      if (taken) throw new TenantError(`the slug "${options.slug}" is taken`);
      db.prepare('UPDATE tenant SET slug = ? WHERE id = ?').run(options.slug, current.id);
      appendPlatformEvent(db, {
        actor: options.actor,
        action: 'tenant.slug_set',
        tenantId: current.id,
        subjectType: 'tenant',
        subjectId: String(current.id),
        detail: null,
      });
      return { ...current, slug: options.slug };
    })
    .immediate();
}
