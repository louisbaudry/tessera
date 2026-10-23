/**
 * The `platform.sqlite` events that are not a row this file owns
 * (audit-spec.md §2.5; backlog #57): a refused login, a project's
 * creation or deletion — a file on disk, not a row here — and a file
 * leaving over HTTP. Account and session events are written by
 * `accounts.ts`, inside the transaction of the row they describe.
 */

import { createHash } from 'node:crypto';

import type { AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { verifyAudit } from '../audit/events.js';
import { getTenantById, TenantError } from './tenants.js';

import { appendPlatformEvent } from './audit-write.js';

/**
 * A project as this file names it: its tenant and its slug, the two
 * coordinates its path is built from — never the storage root, which is
 * a capability, not a name (spec §2.5). The tenant owns it, not whoever of
 * its staff made it (`planning/tenant-spec.md` D1).
 */
export interface ProjectRef {
  readonly tenantId: number;
  readonly name: string;
}

/**
 * The `subject_id` of an event about a project: `t<tenant id>/<slug>`. Before
 * backlog #205 it was `<owner account id>/<slug>`, and those events are immutable
 * and hash-chained, so they keep it. The `t` prefix is what stops an old
 * `3/job` (an account) being read as a new one (a tenant): a tenant's id is not its
 * founder's account id once a vendor sits between two owners.
 */
export const projectSubjectId = (project: ProjectRef): string =>
  `t${project.tenantId}/${project.name}`;

export interface FailedLoginOptions {
  /** The gate that refused it — never the account it named (spec §2.5). */
  readonly actor: AuditActor;
  /** The account the email matched, or `null` if none did. */
  readonly accountId: number | null;
  readonly reason: 'unknown_email' | 'wrong_password' | 'not_on_this_host';
  /**
   * The tenant whose host the attempt was made on, when it was on one (`tenant-spec.md` D14): the
   * attempt is about that tenant, whose admin reads it in their slice. `null` otherwise.
   */
  readonly tenantId?: number | null;
}

/** Records a refused login. The email tried is not recorded: it would be hashed, so unerasable. */
export function recordFailedLogin(
  db: Database.Database,
  options: FailedLoginOptions,
): void {
  appendPlatformEvent(db, {
    actor: options.actor,
    action: 'auth.login_failed',
    // About no tenant unless it was made on one's host: nobody is signed in, and the email is not kept.
    tenantId: options.tenantId ?? null,
    subjectType: 'account',
    subjectId: options.accountId === null ? null : String(options.accountId),
    detail: { reason: options.reason },
  });
}

export interface ProjectChangeOptions {
  readonly actor: AuditActor;
  readonly project: ProjectRef;
}

/**
 * Records a project's creation or deletion and makes the change, in
 * that order, inside one platform transaction. `change` is a filesystem
 * write no SQLite transaction covers, so the event goes first: if the
 * change throws, the event rolls back with it. The one unrecorded
 * window left is a failed `COMMIT` after a successful change.
 */
export function recordProjectChange<T>(
  db: Database.Database,
  action: 'project.created' | 'project.deleted',
  options: ProjectChangeOptions,
  change: () => T,
): T {
  return db.transaction((): T => {
    appendPlatformEvent(db, {
      actor: options.actor,
      action,
      tenantId: options.project.tenantId,
      subjectType: 'project',
      subjectId: projectSubjectId(options.project),
      detail: null,
    });
    return change();
  })();
}

export interface DownloadOptions {
  readonly actor: AuditActor;
  readonly project: ProjectRef;
  /** The file's id in the project it came from. */
  readonly fileId: number;
  readonly name: string;
  /** SHA-256 of exactly the bytes about to be sent. */
  readonly sha256: string;
}

/**
 * Records a file leaving the system (spec decision 9). Called before
 * the first byte is sent, so a failed write means nothing left.
 */
export function recordDownload(db: Database.Database, options: DownloadOptions): void {
  appendPlatformEvent(db, {
    actor: options.actor,
    action: 'file.downloaded',
    tenantId: options.project.tenantId,
    subjectType: 'project',
    subjectId: projectSubjectId(options.project),
    detail: { file_id: options.fileId, name: options.name, sha256: options.sha256 },
  });
}

/** One event in a tenant's slice of the log, as its admin reads it (backlog #211). */
export interface TenantAuditEvent {
  readonly id: number;
  readonly at: string;
  /** `account:<id>`, `system:<name>` and so on (`formatActor`). */
  readonly actor: string;
  /** The display label snapshotted at the time; `[erased]` once the person was erased. */
  readonly actorLabel: string | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  /** Ids and states only, by the log's own rule (a detail is hashed, so it holds nothing erasable). */
  readonly detail: unknown;
}

export interface ListTenantEventsOptions {
  /** At most this many, newest first; default {@link DEFAULT_TENANT_EVENTS}, capped at {@link MAX_TENANT_EVENTS}. */
  readonly limit?: number;
  /** Only events older than this id: the cursor to the next page. */
  readonly beforeId?: number;
}

export const DEFAULT_TENANT_EVENTS = 100;
export const MAX_TENANT_EVENTS = 500;

/**
 * A tenant's own events, newest first. Only rows stamped with the tenant (`tenant_id`,
 * hashed with the row, audit-spec.md §3.1): never another tenant's, never an event about
 * no tenant (a refused login, a vendor's own session), and never one written before the
 * column existed, which kept none and cannot be given one without breaking its hash.
 */
export function listTenantEvents(
  db: Database.Database,
  tenantId: number,
  options: ListTenantEventsOptions = {},
): TenantAuditEvent[] {
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_TENANT_EVENTS)),
    MAX_TENANT_EVENTS,
  );
  const rows = db
    .prepare(
      `SELECT id, at, actor, actor_label AS actorLabel, action,
              subject_type AS subjectType, subject_id AS subjectId, detail
         FROM audit_event
        WHERE tenant_id = @tenantId AND id < @before
        ORDER BY id DESC LIMIT @limit`,
    )
    .all({
      tenantId,
      before: options.beforeId ?? Number.MAX_SAFE_INTEGER,
      limit,
    }) as Array<Omit<TenantAuditEvent, 'detail'> & { detail: string | null }>;
  return rows.map((row) => ({
    ...row,
    detail: row.detail === null ? null : JSON.parse(row.detail),
  }));
}

export interface ExportTenantAuditOptions {
  readonly tenantId: number;
  /** The operator running it (`cli:<OS user>`): required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

/** What leaves: the text, and the facts the log keeps of it. */
export interface TenantAuditExport {
  /** One header line, then one JSON line per event, oldest first. */
  readonly text: string;
  /** The events in it, not counting the `tenant.audit_exported` it logs. */
  readonly events: number;
  readonly sha256: string;
}

/**
 * A tenant's whole slice of the log as JSON lines, for the operator to hand over or to
 * keep on offboarding (`tenant-spec.md` §6 invariant 7, backlog #211). Each line is the row
 * as stored (`detail` the stored string, `chain_hash` and `tenant_id` included), so a holder can
 * recompute every hash from the row and the previous hash; the header says whether the
 * **whole** log verified when it was cut, because a slice has gaps by nature and cannot
 * verify alone. The export is logged before it is returned, in the same transaction, so a
 * failed write means nothing left (spec decision 9), and the event carries a count and a
 * digest, never an event.
 *
 * @throws {TenantError} for a tenant that does not exist.
 */
export function exportTenantAudit(
  db: Database.Database,
  options: ExportTenantAuditOptions,
): TenantAuditExport {
  return db.transaction((): TenantAuditExport => {
    if (!getTenantById(db, options.tenantId)) {
      throw new TenantError(`no tenant #${options.tenantId}`);
    }
    const whole = verifyAudit(db);
    const rows = db
      .prepare('SELECT * FROM audit_event WHERE tenant_id = ? ORDER BY id')
      .all(options.tenantId) as Array<Record<string, unknown>>;
    const header = {
      kind: 'tessera.tenant-audit',
      version: 1,
      tenant_id: options.tenantId,
      events: rows.length,
      whole_log_intact: whole.brokenAt === null,
      whole_log_events: whole.events,
    };
    const text = [header, ...rows].map((line) => JSON.stringify(line)).join('\n') + '\n';
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    appendPlatformEvent(db, {
      actor: options.actor,
      action: 'tenant.audit_exported',
      tenantId: options.tenantId,
      subjectType: 'tenant',
      subjectId: String(options.tenantId),
      detail: { events: rows.length, sha256 },
    });
    return { text, events: rows.length, sha256 };
  })();
}
