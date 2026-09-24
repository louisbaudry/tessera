/**
 * The `portal.sqlite` events that are not a row this file owns
 * (audit-spec.md §2.6; backlog #58): a refused admin login, and a file
 * leaving over HTTP. A login and a delivery are written by `admin.ts`
 * and `files.ts`, inside the transaction of the row they describe;
 * order transitions are `order_event`'s alone (spec decision 7).
 */

import type { AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import type { StoredFile } from './files.js';

export interface FailedAdminLoginOptions {
  /** The gate that refused it — never the admin it named (spec §2.5). */
  readonly actor: AuditActor;
  /** The admin the email matched, or `null` if none did. */
  readonly adminUserId: number | null;
  readonly reason: 'unknown_email' | 'wrong_password';
}

/** Records a refused admin login. The email tried is not recorded: it would be hashed, so unerasable. */
export function recordFailedAdminLogin(
  db: Database.Database,
  options: FailedAdminLoginOptions,
): void {
  appendAuditEvent(db, {
    actor: options.actor,
    action: 'auth.login_failed',
    subjectType: 'admin_user',
    subjectId: options.adminUserId === null ? null : String(options.adminUserId),
    detail: { reason: options.reason },
  });
}

export interface FileDownloadOptions {
  /** `admin:<id>` or `client:<id>` — whoever the route authenticated. */
  readonly actor: AuditActor;
  readonly kind: 'source' | 'delivered';
  readonly file: StoredFile;
  /** SHA-256 of exactly the bytes about to be sent. */
  readonly sha256: string;
}

/**
 * Records a file leaving the system (spec decision 9). The subject is
 * the file's own row — `source_file` or `delivered_file` — so the two
 * tables' ids never collide. Called before the first byte is sent, so a
 * failed write means nothing left.
 */
export function recordFileDownload(
  db: Database.Database,
  options: FileDownloadOptions,
): void {
  appendAuditEvent(db, {
    actor: options.actor,
    action: 'file.downloaded',
    subjectType: options.kind === 'source' ? 'source_file' : 'delivered_file',
    subjectId: String(options.file.id),
    detail: {
      file_id: options.file.id,
      name: options.file.filename,
      sha256: options.sha256,
    },
  });
}
