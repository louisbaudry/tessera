/**
 * A client's contacts (issue #318, `planning/sso-spec.md` D6, §2b, phase A): the people at a client
 * the tenant's admin lets sign in to the portal with Microsoft or Google, beside the private link.
 * A contact is one address, stored lower case and unique within the portal file, and can be
 * disabled and enabled again without losing its row. Signing in is phase B; nothing here changes
 * what a client can do today.
 */

import type Database from 'better-sqlite3';

export interface ClientContact {
  readonly id: number;
  readonly clientId: number;
  readonly email: string;
  readonly createdAt: string;
  readonly disabledAt: string | null;
}

/** The address is already a contact in this portal, of this client or another. */
export class ContactTakenError extends Error {
  constructor() {
    super('that address is already a contact');
    this.name = 'ContactTakenError';
  }
}

interface ContactRow {
  id: number;
  client_id: number;
  email: string;
  created_at: string;
  disabled_at: string | null;
}

const fromRow = (row: ContactRow): ClientContact => ({
  id: row.id,
  clientId: row.client_id,
  email: row.email,
  createdAt: row.created_at,
  disabledAt: row.disabled_at,
});

/**
 * Adds a contact to a client.
 *
 * @param email - Checked for shape by the caller; stored trimmed and lower case.
 * @throws {ContactTakenError} if the address is already a contact in this portal.
 * @throws if `clientId` names no client (a foreign key).
 */
export function createContact(
  db: Database.Database,
  clientId: number,
  email: string,
  now: Date = new Date(),
): ClientContact {
  try {
    const info = db
      .prepare(
        'INSERT INTO client_contact (client_id, email, created_at) VALUES (?, ?, ?)',
      )
      .run(clientId, email.trim().toLowerCase(), now.toISOString());
    return getContact(db, clientId, info.lastInsertRowid as number)!;
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE')
      throw new ContactTakenError();
    throw err;
  }
}

/** One of a client's contacts, or `null`: another client's contact is the same `null`. */
export function getContact(
  db: Database.Database,
  clientId: number,
  contactId: number,
): ClientContact | null {
  const row = db
    .prepare('SELECT * FROM client_contact WHERE id = ? AND client_id = ?')
    .get(contactId, clientId) as ContactRow | undefined;
  return row ? fromRow(row) : null;
}

/** A client's contacts, oldest first. */
export function listContacts(db: Database.Database, clientId: number): ClientContact[] {
  return (
    db
      .prepare('SELECT * FROM client_contact WHERE client_id = ? ORDER BY id')
      .all(clientId) as ContactRow[]
  ).map(fromRow);
}

/**
 * Disables a contact (it will not be able to sign in) or enables it again. Disabling one that is
 * already disabled keeps its first date.
 *
 * @returns The contact as it now is, or `null` if the client has no such contact.
 */
export function setContactDisabled(
  db: Database.Database,
  clientId: number,
  contactId: number,
  disabled: boolean,
  now: Date = new Date(),
): ClientContact | null {
  // A disabled contact opens nothing: its sessions end with it (issue #342).
  if (disabled && getContact(db, clientId, contactId)) {
    db.prepare('DELETE FROM client_contact_session WHERE contact_id = ?').run(contactId);
  }
  db.prepare(
    disabled
      ? 'UPDATE client_contact SET disabled_at = COALESCE(disabled_at, ?) WHERE id = ? AND client_id = ?'
      : 'UPDATE client_contact SET disabled_at = NULL WHERE id = ? AND client_id = ?',
  ).run(...(disabled ? [now.toISOString(), contactId, clientId] : [contactId, clientId]));
  return getContact(db, clientId, contactId);
}
