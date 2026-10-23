/**
 * The `platform.sqlite` events that are not a row this file owns
 * (audit-spec.md §2.5; backlog #57): a refused login, a project's
 * creation or deletion — a file on disk, not a row here — and a file
 * leaving over HTTP. Account and session events are written by
 * `accounts.ts`, inside the transaction of the row they describe.
 */

import type { AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';

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
  readonly reason: 'unknown_email' | 'wrong_password';
}

/** Records a refused login. The email tried is not recorded: it would be hashed, so unerasable. */
export function recordFailedLogin(
  db: Database.Database,
  options: FailedLoginOptions,
): void {
  appendAuditEvent(db, {
    actor: options.actor,
    action: 'auth.login_failed',
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
    appendAuditEvent(db, {
      actor: options.actor,
      action,
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
  appendAuditEvent(db, {
    actor: options.actor,
    action: 'file.downloaded',
    subjectType: 'project',
    subjectId: projectSubjectId(options.project),
    detail: { file_id: options.fileId, name: options.name, sha256: options.sha256 },
  });
}
