/** A client's contacts (issue #318, sso-spec.md §2b, phase A). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ContactTakenError,
  createClient,
  createContact,
  getContact,
  listContacts,
  openPortalDb,
  setContactDisabled,
} from './index.js';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-contacts-'));
  db = openPortalDb(join(dir, 'portal.sqlite'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('client contacts', () => {
  it('are an address per person, lower case, listed per client', () => {
    const a = createClient(db, 'Client A', 'a@client.example', 'tok-a');
    const b = createClient(db, 'Client B', 'b@client.example', 'tok-b');
    const made = createContact(db, a.id, '  Pat@Client.Example ');
    expect(made).toMatchObject({
      clientId: a.id,
      email: 'pat@client.example',
      disabledAt: null,
    });
    createContact(db, b.id, 'sam@client.example');
    expect(listContacts(db, a.id).map((c) => c.email)).toEqual(['pat@client.example']);
  });

  it('refuses an address that is already a contact here, of any client', () => {
    const a = createClient(db, 'Client A', 'a@client.example', 'tok-a');
    const b = createClient(db, 'Client B', 'b@client.example', 'tok-b');
    createContact(db, a.id, 'pat@client.example');
    expect(() => createContact(db, b.id, 'PAT@client.example')).toThrow(
      ContactTakenError,
    );
    expect(() => createContact(db, 999, 'new@client.example')).toThrow();
  });

  it('are disabled and enabled again, and another client’s contact is none of this one’s', () => {
    const a = createClient(db, 'Client A', 'a@client.example', 'tok-a');
    const b = createClient(db, 'Client B', 'b@client.example', 'tok-b');
    const pat = createContact(db, a.id, 'pat@client.example');
    const first = setContactDisabled(
      db,
      a.id,
      pat.id,
      true,
      new Date('2026-11-03T10:00:00Z'),
    );
    expect(first?.disabledAt).toBe('2026-11-03T10:00:00.000Z');
    // disabling again keeps the first date
    expect(setContactDisabled(db, a.id, pat.id, true)?.disabledAt).toBe(
      first?.disabledAt,
    );
    expect(setContactDisabled(db, a.id, pat.id, false)?.disabledAt).toBeNull();
    expect(setContactDisabled(db, b.id, pat.id, true)).toBeNull();
    expect(getContact(db, a.id, pat.id)?.disabledAt).toBeNull();
  });
});
