/**
 * The portal client a project is work for (backlog #130, issue #156): an
 * optional number the owner sets, so what is known about a client (a vendor
 * pool today, a margin later) can find the projects that are theirs.
 *
 * Absence-based, like `fuzzy_setting`: no row is "not for a portal client".
 * The id is the owner's word for a client in `portal.sqlite`, never checked
 * against it: that is another file, often another process, and a wrong id
 * simply matches nothing. A change is one `project.setting_changed` in the
 * project's log, in the transaction that writes it.
 */

import type { AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';

/** The `key` of the `project.setting_changed` a change here logs. */
export const PORTAL_CLIENT_SETTING = 'portal_client';

export class PortalClientSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortalClientSettingError';
  }
}

/** The portal client the project is for, or null when it is for none. */
export function getPortalClient(db: Database.Database): number | null {
  const row = db
    .prepare('SELECT client_id FROM portal_client_setting WHERE id = 1')
    .get() as { client_id: number } | undefined;
  return row === undefined ? null : row.client_id;
}

/**
 * Sets the portal client (a positive whole number), or clears it with `null`.
 * Logs the change, from and to (a no-op writes nothing and logs nothing).
 */
export function setPortalClient(
  db: Database.Database,
  clientId: number | null,
  actor: AuditActor,
): number | null {
  if (clientId !== null && (!Number.isSafeInteger(clientId) || clientId < 1)) {
    throw new PortalClientSettingError(
      'a portal client is a positive whole number, or none',
    );
  }
  return db.transaction((): number | null => {
    const from = getPortalClient(db);
    if (clientId === null)
      db.prepare('DELETE FROM portal_client_setting WHERE id = 1').run();
    else {
      db.prepare(
        `INSERT INTO portal_client_setting (id, client_id) VALUES (1, @clientId)
         ON CONFLICT (id) DO UPDATE SET client_id = @clientId`,
      ).run({ clientId });
    }
    const to = getPortalClient(db);
    if (to !== from) {
      appendAuditEvent(db, {
        actor,
        action: 'project.setting_changed',
        subjectType: 'project',
        subjectId: null,
        detail: { key: PORTAL_CLIENT_SETTING, from, to },
      });
    }
    return to;
  })();
}
