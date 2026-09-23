/** `client` repository (portal-v0-spec.md §6). */

import { randomBytes } from 'node:crypto';

import type Database from 'better-sqlite3';

export interface Client {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly accessToken: string;
  readonly createdAt: string;
}

interface ClientRow {
  id: number;
  name: string;
  email: string;
  access_token: string;
  created_at: string;
}

const fromRow = (row: ClientRow): Client => ({
  id: row.id,
  name: row.name,
  email: row.email,
  accessToken: row.access_token,
  createdAt: row.created_at,
});

/** A URL-safe token for the client's private access link. */
export function generateAccessToken(): string {
  return randomBytes(24).toString('base64url');
}

export function createClient(
  db: Database.Database,
  name: string,
  email: string,
  accessToken: string = generateAccessToken(),
): Client {
  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO client (name, email, access_token, created_at)
       VALUES (@name, @email, @access_token, @created_at)`,
    )
    .run({ name, email, access_token: accessToken, created_at: createdAt });
  return {
    id: info.lastInsertRowid as number,
    name,
    email,
    accessToken,
    createdAt,
  };
}

export function getClientByToken(
  db: Database.Database,
  accessToken: string,
): Client | null {
  const row = db
    .prepare('SELECT * FROM client WHERE access_token = ?')
    .get(accessToken) as ClientRow | undefined;
  return row ? fromRow(row) : null;
}

export function getClient(db: Database.Database, id: number): Client | null {
  const row = db.prepare('SELECT * FROM client WHERE id = ?').get(id) as
    ClientRow | undefined;
  return row ? fromRow(row) : null;
}

export function listClients(db: Database.Database): Client[] {
  return (db.prepare('SELECT * FROM client ORDER BY id').all() as ClientRow[]).map(
    fromRow,
  );
}
