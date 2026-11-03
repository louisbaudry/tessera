/**
 * A client contact signing in with a provider (issue #342, sso-spec.md §2b): the one-time link, the
 * attempt and its hand-off, contact sessions, and the private-link switch. Each rule is a test.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimPortalSsoCallback,
  completePortalSsoCallback,
  ContactIdentityTakenError,
  createClient,
  createContact,
  createContactSession,
  createPortalSsoAttempt,
  findContactByIdentity,
  getClientByContactSession,
  getClientByToken,
  issueContactSigninLink,
  linkContactIdentity,
  LinkSwitchError,
  openContactSigninLink,
  openPortalDb,
  redeemPortalSsoHandoff,
  setClientLinkEnabled,
  setContactDisabled,
  type Client,
} from './index.js';

let dir: string;
let db: Database.Database;
let acme: Client;
let other: Client;
const id = (subject: string) => ({
  provider: 'google' as const,
  issuer: 'https://accounts.google.com',
  subject,
});
const BINDING = 'a-browser-secret-0123456789';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-contact-sso-'));
  db = openPortalDb(join(dir, 'portal.sqlite'));
  acme = createClient(db, 'Client A', 'a@client.example', 'tok-a');
  other = createClient(db, 'Client B', 'b@client.example', 'tok-b');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('the one-time sign-in link', () => {
  it('ties the contact to its first identity and is spent by it', () => {
    const pat = createContact(db, acme.id, 'pat@client.example');
    expect(issueContactSigninLink(db, acme.id, pat.id, 'link-1')).toBe('link-1');
    expect(openContactSigninLink(db, 'link-1')?.id).toBe(pat.id);
    expect(linkContactIdentity(db, 'link-1', id('g-pat'))?.id).toBe(pat.id);
    expect(openContactSigninLink(db, 'link-1')).toBeNull();
    expect(findContactByIdentity(db, id('g-pat'))?.id).toBe(pat.id);
  });

  it('is replaced by a new one, refused for another client’s contact, and dead once expired', () => {
    const pat = createContact(db, acme.id, 'pat@client.example');
    expect(issueContactSigninLink(db, other.id, pat.id, 'x')).toBeNull();
    const t0 = new Date('2026-11-03T00:00:00Z');
    issueContactSigninLink(db, acme.id, pat.id, 'old', t0);
    issueContactSigninLink(db, acme.id, pat.id, 'new', t0);
    expect(openContactSigninLink(db, 'old', t0)).toBeNull();
    expect(openContactSigninLink(db, 'new', new Date('2026-12-31T00:00:00Z'))).toBeNull();
  });

  it('refuses an identity that opens another contact, and stays usable', () => {
    const pat = createContact(db, acme.id, 'pat@client.example');
    const sam = createContact(db, other.id, 'sam@client.example');
    issueContactSigninLink(db, acme.id, pat.id, 'pat-link');
    linkContactIdentity(db, 'pat-link', id('g-pat'));
    issueContactSigninLink(db, other.id, sam.id, 'sam-link');
    expect(() => linkContactIdentity(db, 'sam-link', id('g-pat'))).toThrow(
      ContactIdentityTakenError,
    );
    expect(openContactSigninLink(db, 'sam-link')?.id).toBe(sam.id);
  });

  it('opens nothing for a disabled contact', () => {
    const pat = createContact(db, acme.id, 'pat@client.example');
    issueContactSigninLink(db, acme.id, pat.id, 'link-1');
    linkContactIdentity(db, 'link-1', id('g-pat'));
    setContactDisabled(db, acme.id, pat.id, true);
    expect(findContactByIdentity(db, id('g-pat'))).toBeNull();
    expect(issueContactSigninLink(db, acme.id, pat.id, 'link-2')).toBeNull();
  });
});

describe('a sign-in in flight', () => {
  const round = (state: string, binding = BINDING) => {
    createPortalSsoAttempt(db, {
      state,
      binding: BINDING,
      nonce: 'n',
      codeVerifier: 'v',
      provider: 'google',
      purpose: 'contact_login',
    });
    const attempt = claimPortalSsoCallback(db, state)!;
    expect(claimPortalSsoCallback(db, state)).toBeNull();
    completePortalSsoCallback(db, attempt.id, id('g-1'), `code-${state}`);
    return redeemPortalSsoHandoff(db, `code-${state}`, {
      purpose: 'contact_login',
      binding,
    });
  };

  it('hands back the identity once, for the browser that started it', () => {
    expect(round('s1')).toEqual(id('g-1'));
    expect(
      redeemPortalSsoHandoff(db, 'code-s1', {
        purpose: 'contact_login',
        binding: BINDING,
      }),
    ).toBeNull();
    expect(round('s2', 'another-browser-secret-xyz')).toBeNull();
  });

  it('refuses a code for another purpose, and spends it', () => {
    createPortalSsoAttempt(db, {
      state: 's3',
      binding: BINDING,
      nonce: 'n',
      codeVerifier: 'v',
      provider: 'google',
      purpose: 'contact_link',
    });
    const attempt = claimPortalSsoCallback(db, 's3')!;
    completePortalSsoCallback(db, attempt.id, id('g-1'), 'code-s3');
    expect(
      redeemPortalSsoHandoff(db, 'code-s3', {
        purpose: 'contact_login',
        binding: BINDING,
      }),
    ).toBeNull();
    expect(
      redeemPortalSsoHandoff(db, 'code-s3', {
        purpose: 'contact_link',
        binding: BINDING,
      }),
    ).toBeNull();
  });
});

describe('contact sessions and the private-link switch', () => {
  it('open the contact’s client only while the contact is enabled', () => {
    const pat = createContact(db, acme.id, 'pat@client.example');
    createContactSession(db, pat, 'session-1', 'google');
    expect(getClientByContactSession(db, 'session-1')?.id).toBe(acme.id);
    setContactDisabled(db, acme.id, pat.id, true);
    expect(getClientByContactSession(db, 'session-1')).toBeNull();
    // enabling again does not bring the ended session back
    setContactDisabled(db, acme.id, pat.id, false);
    expect(getClientByContactSession(db, 'session-1')).toBeNull();
  });

  it('logs a contact sign-in as the client, with the contact’s number and no address', () => {
    const pat = createContact(db, acme.id, 'pat@client.example');
    createContactSession(db, pat, 'session-1', 'microsoft');
    const row = db
      .prepare(
        "SELECT actor, detail FROM audit_event WHERE action = 'auth.contact_login'",
      )
      .get() as { actor: string; detail: string };
    expect(row.actor).toBe(`client:${acme.id}`);
    expect(JSON.parse(row.detail)).toEqual({ provider: 'microsoft', contact: pat.id });
    expect(row.detail).not.toContain('@');
  });

  it('will not turn a link off until a contact can sign in, and then closes the link', () => {
    expect(() => setClientLinkEnabled(db, acme.id, false)).toThrow(LinkSwitchError);
    const pat = createContact(db, acme.id, 'pat@client.example');
    expect(() => setClientLinkEnabled(db, acme.id, false)).toThrow(LinkSwitchError);
    issueContactSigninLink(db, acme.id, pat.id, 'link-1');
    linkContactIdentity(db, 'link-1', id('g-pat'));
    expect(setClientLinkEnabled(db, acme.id, false)?.linkEnabled).toBe(false);
    expect(getClientByToken(db, 'tok-a')).toBeNull();
    expect(getClientByToken(db, 'tok-b')?.id).toBe(other.id);
    expect(setClientLinkEnabled(db, acme.id, true)?.linkEnabled).toBe(true);
    expect(getClientByToken(db, 'tok-a')?.id).toBe(acme.id);
    expect(setClientLinkEnabled(db, 999, true)).toBeNull();
  });
});
