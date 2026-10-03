/**
 * The roster (vendor-spec.md §5 and its #46 note): who an owner engages,
 * the language pairs and specialties they work in. Every write records its
 * `audit_event` in the same transaction, actor required (audit-spec.md §2).
 * An event's detail names *which* parts changed, never what they changed
 * to: a name is personal and the detail is hashed.
 */

import { primarySubtag, type AuditActor } from '@cat-tool/core';
import { normalizeSpecialty } from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { VendorError } from './error.js';

export interface LanguagePair {
  /** Primary subtag, lower-case: `en-GB` is `en`. */
  readonly src: string;
  readonly tgt: string;
}

export interface Vendor {
  readonly id: number;
  /** The platform account this entry is: installation-local, never an email. */
  readonly accountId: number;
  readonly displayName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VendorProfile extends Vendor {
  readonly languages: readonly LanguagePair[];
  readonly specialties: readonly string[];
}

interface VendorRow {
  id: number;
  account_id: number;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

const fromRow = (r: VendorRow): Vendor => ({
  id: r.id,
  accountId: r.account_id,
  displayName: r.display_name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** A pair as stored: primary subtags, each non-empty and different from the other. */
export function normalizePair(pair: LanguagePair): LanguagePair {
  const src = primarySubtag(pair.src.trim());
  const tgt = primarySubtag(pair.tgt.trim());
  if (src === '' || tgt === '')
    throw new VendorError('a language pair needs both languages');
  if (src === tgt) throw new VendorError(`"${src}" into "${tgt}" is not a language pair`);
  return { src, tgt };
}

const pairKey = (p: LanguagePair): string => `${p.src}>${p.tgt}`;

function cleanPairs(pairs: readonly LanguagePair[]): LanguagePair[] {
  const byKey = new Map<string, LanguagePair>();
  for (const p of pairs) {
    const n = normalizePair(p);
    byKey.set(pairKey(n), n);
  }
  return [...byKey.values()].sort((a, b) => pairKey(a).localeCompare(pairKey(b)));
}

function cleanTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map(normalizeSpecialty).filter((t) => t !== ''))].sort();
}

const cleanName = (name: string | null | undefined): string | null => {
  const trimmed = name?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

export interface AddVendorOptions {
  readonly accountId: number;
  readonly displayName?: string | null;
  readonly languages?: readonly LanguagePair[];
  readonly specialties?: readonly string[];
  /** Who added them — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

/** Puts an account on the roster. An account is on it once. */
export function addVendor(db: Database.Database, options: AddVendorOptions): Vendor {
  if (!Number.isSafeInteger(options.accountId) || options.accountId < 1) {
    throw new VendorError('a vendor is an account: accountId must be a positive integer');
  }
  const at = new Date().toISOString();
  return db.transaction((): Vendor => {
    if (getVendorByAccount(db, options.accountId)) {
      throw new VendorError(`account #${options.accountId} is already on the roster`);
    }
    const info = db
      .prepare(
        `INSERT INTO vendor (account_id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(options.accountId, cleanName(options.displayName), at, at);
    const id = info.lastInsertRowid as number;
    writeLanguages(db, id, cleanPairs(options.languages ?? []));
    writeSpecialties(db, id, cleanTags(options.specialties ?? []));
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'vendor.added',
      subjectType: 'vendor',
      subjectId: String(id),
      detail: null,
    });
    return getVendor(db, id)!;
  })();
}

function writeLanguages(db: Database.Database, vendorId: number, pairs: LanguagePair[]) {
  db.prepare('DELETE FROM vendor_language WHERE vendor_id = ?').run(vendorId);
  const insert = db.prepare(
    'INSERT INTO vendor_language (vendor_id, src_lang, tgt_lang) VALUES (?, ?, ?)',
  );
  for (const p of pairs) insert.run(vendorId, p.src, p.tgt);
}

function writeSpecialties(db: Database.Database, vendorId: number, tags: string[]) {
  db.prepare('DELETE FROM vendor_specialty WHERE vendor_id = ?').run(vendorId);
  const insert = db.prepare(
    'INSERT INTO vendor_specialty (vendor_id, tag) VALUES (?, ?)',
  );
  for (const t of tags) insert.run(vendorId, t);
}

export function getVendor(db: Database.Database, id: number): Vendor | null {
  const row = db.prepare('SELECT * FROM vendor WHERE id = ?').get(id) as
    VendorRow | undefined;
  return row ? fromRow(row) : null;
}

export function getVendorByAccount(
  db: Database.Database,
  accountId: number,
): Vendor | null {
  const row = db.prepare('SELECT * FROM vendor WHERE account_id = ?').get(accountId) as
    VendorRow | undefined;
  return row ? fromRow(row) : null;
}

/** Everyone on the roster, in the order they were added. */
export function listVendors(db: Database.Database): Vendor[] {
  return (db.prepare('SELECT * FROM vendor ORDER BY id').all() as VendorRow[]).map(
    fromRow,
  );
}

export function listLanguages(db: Database.Database, vendorId: number): LanguagePair[] {
  return (
    db
      .prepare(
        'SELECT src_lang, tgt_lang FROM vendor_language WHERE vendor_id = ? ORDER BY src_lang, tgt_lang',
      )
      .all(vendorId) as Array<{ src_lang: string; tgt_lang: string }>
  ).map((r) => ({ src: r.src_lang, tgt: r.tgt_lang }));
}

export function listSpecialties(db: Database.Database, vendorId: number): string[] {
  return (
    db
      .prepare('SELECT tag FROM vendor_specialty WHERE vendor_id = ? ORDER BY tag')
      .all(vendorId) as Array<{ tag: string }>
  ).map((r) => r.tag);
}

export function getProfile(
  db: Database.Database,
  vendorId: number,
): VendorProfile | null {
  const vendor = getVendor(db, vendorId);
  if (!vendor) return null;
  return {
    ...vendor,
    languages: listLanguages(db, vendorId),
    specialties: listSpecialties(db, vendorId),
  };
}

export interface UpdateProfileOptions {
  readonly vendorId: number;
  /** Omit to leave it; `null` or blank clears it. */
  readonly displayName?: string | null;
  /** Omit to leave them; a list replaces the whole set. */
  readonly languages?: readonly LanguagePair[];
  readonly specialties?: readonly string[];
  readonly actor: AuditActor;
}

/**
 * Replaces the parts of a profile it is given and records one event
 * naming those that actually changed; a call that changes nothing writes
 * nothing, not even the event.
 */
export function updateProfile(
  db: Database.Database,
  options: UpdateProfileOptions,
): VendorProfile {
  return db.transaction((): VendorProfile => {
    const before = getProfile(db, options.vendorId);
    if (!before) throw new VendorError(`no vendor #${options.vendorId}`);
    const changed: Array<'display_name' | 'languages' | 'specialties'> = [];

    if (options.displayName !== undefined) {
      const name = cleanName(options.displayName);
      if (name !== before.displayName) {
        db.prepare('UPDATE vendor SET display_name = ? WHERE id = ?').run(
          name,
          options.vendorId,
        );
        changed.push('display_name');
      }
    }
    if (options.languages !== undefined) {
      const pairs = cleanPairs(options.languages);
      if (pairs.map(pairKey).join('|') !== before.languages.map(pairKey).join('|')) {
        writeLanguages(db, options.vendorId, pairs);
        changed.push('languages');
      }
    }
    if (options.specialties !== undefined) {
      const tags = cleanTags(options.specialties);
      if (tags.join('|') !== before.specialties.join('|')) {
        writeSpecialties(db, options.vendorId, tags);
        changed.push('specialties');
      }
    }
    if (changed.length > 0) {
      db.prepare('UPDATE vendor SET updated_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        options.vendorId,
      );
      appendAuditEvent(db, {
        actor: options.actor,
        action: 'vendor.profile_changed',
        subjectType: 'vendor',
        subjectId: String(options.vendorId),
        detail: { changed },
      });
    }
    return getProfile(db, options.vendorId)!;
  })();
}
