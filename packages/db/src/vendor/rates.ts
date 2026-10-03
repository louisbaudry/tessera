/**
 * A vendor's rate card (vendor-spec.md §5 and its #46 note). A rate is a
 * row and never an edit: the rate in force at a date is the latest entry
 * effective on or before it, and an entry can only look forward, so a
 * "newer" row can never rewrite what a past period paid.
 */

import type { AuditActor } from '@cat-tool/core';
import { isRateTier, type RateTier } from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { VendorError } from './error.js';
import { normalizePair, type LanguagePair } from './vendors.js';

export interface VendorRateEntry {
  readonly id: number;
  readonly vendorId: number;
  readonly pair: LanguagePair;
  readonly tier: RateTier;
  /** Millionths of a currency unit per word. */
  readonly rateMicros: number;
  /** ISO 4217, upper-case. */
  readonly currency: string;
  /** `YYYY-MM-DD`, UTC. */
  readonly effectiveFrom: string;
  readonly createdAt: string;
}

interface Row {
  id: number;
  vendor_id: number;
  src_lang: string;
  tgt_lang: string;
  tier: RateTier;
  rate_micros: number;
  currency: string;
  effective_from: string;
  created_at: string;
}

const fromRow = (r: Row): VendorRateEntry => ({
  id: r.id,
  vendorId: r.vendor_id,
  pair: { src: r.src_lang, tgt: r.tgt_lang },
  tier: r.tier,
  rateMicros: r.rate_micros,
  currency: r.currency,
  effectiveFrom: r.effective_from,
  createdAt: r.created_at,
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC date (`YYYY-MM-DD`) of a date or an ISO timestamp, or an error for anything else. */
export function utcDate(at: string | Date): string {
  const text = typeof at === 'string' ? at : at.toISOString();
  const day = text.slice(0, 10);
  if (!DATE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new VendorError(`"${text}" is not a date`);
  }
  // `Date.parse` rolls 2026-02-31 over; a date that is not itself is not a date.
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new VendorError(`"${day}" is not a date`);
  }
  return day;
}

export interface SetVendorRateOptions {
  readonly vendorId: number;
  readonly pair: LanguagePair;
  readonly tier: RateTier;
  /** A non-negative integer: millionths of a currency unit per word. */
  readonly rateMicros: number;
  /** ISO 4217: three letters. */
  readonly currency: string;
  /** `YYYY-MM-DD`. Not before today, nor before the newest entry for the same key. */
  readonly effectiveFrom: string;
  readonly actor: AuditActor;
  /** For tests: what "today" is. */
  readonly now?: Date;
}

/**
 * Adds a rate-card entry and records `vendor.rate_set` with it. Refuses a
 * date before today, and a date before the newest entry already there for
 * the same vendor, pair and tier: either would let a later row change what
 * an earlier period paid. A mistake is corrected by a later entry.
 */
export function setVendorRate(
  db: Database.Database,
  options: SetVendorRateOptions,
): VendorRateEntry {
  if (!isRateTier(options.tier)) {
    throw new VendorError(`unknown rate tier "${String(options.tier)}"`);
  }
  if (!Number.isSafeInteger(options.rateMicros) || options.rateMicros < 0) {
    throw new VendorError('a rate is a non-negative integer of micros per word');
  }
  const currency = options.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new VendorError(`"${options.currency}" is not a three-letter currency code`);
  }
  const effectiveFrom = utcDate(options.effectiveFrom);
  if (effectiveFrom !== options.effectiveFrom) {
    throw new VendorError('effectiveFrom is a date: YYYY-MM-DD');
  }
  const now = options.now ?? new Date();
  const today = utcDate(now);
  const pair = normalizePair(options.pair);

  return db.transaction((): VendorRateEntry => {
    if (!db.prepare('SELECT 1 FROM vendor WHERE id = ?').get(options.vendorId)) {
      throw new VendorError(`no vendor #${options.vendorId}`);
    }
    if (effectiveFrom < today) {
      throw new VendorError(
        `a rate cannot take effect on ${effectiveFrom}, which is in the past: ` +
          `it would change what that period paid`,
      );
    }
    const newest = db
      .prepare(
        `SELECT MAX(effective_from) AS d FROM rate_card_entry
         WHERE vendor_id = ? AND src_lang = ? AND tgt_lang = ? AND tier = ?`,
      )
      .get(options.vendorId, pair.src, pair.tgt, options.tier) as { d: string | null };
    if (newest.d !== null && effectiveFrom < newest.d) {
      throw new VendorError(
        `a rate cannot take effect on ${effectiveFrom}: an entry from ${newest.d} ` +
          `is already there, and an earlier date would rewrite the history after it`,
      );
    }
    const info = db
      .prepare(
        `INSERT INTO rate_card_entry
           (vendor_id, src_lang, tgt_lang, tier, rate_micros, currency, effective_from, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        options.vendorId,
        pair.src,
        pair.tgt,
        options.tier,
        options.rateMicros,
        currency,
        effectiveFrom,
        now.toISOString(),
      );
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'vendor.rate_set',
      subjectType: 'vendor',
      subjectId: String(options.vendorId),
      detail: {
        src_lang: pair.src,
        tgt_lang: pair.tgt,
        tier: options.tier,
        rate_micros: options.rateMicros,
        currency,
        effective_from: effectiveFrom,
      },
    });
    return fromRow(
      db
        .prepare('SELECT * FROM rate_card_entry WHERE id = ?')
        .get(info.lastInsertRowid) as Row,
    );
  })();
}

export interface VendorRateKey {
  readonly vendorId: number;
  readonly pair: LanguagePair;
  readonly tier: RateTier;
}

/**
 * The rate in force on a date (or an ISO timestamp's UTC date): the latest
 * entry effective on or before it, the later-written one if two share a
 * day. Null when none had taken effect yet. Adding a newer entry never
 * changes the answer for an earlier date.
 */
export function vendorRateAt(
  db: Database.Database,
  key: VendorRateKey,
  at: string | Date,
): VendorRateEntry | null {
  const pair = normalizePair(key.pair);
  const row = db
    .prepare(
      `SELECT * FROM rate_card_entry
       WHERE vendor_id = ? AND src_lang = ? AND tgt_lang = ? AND tier = ?
         AND effective_from <= ?
       ORDER BY effective_from DESC, id DESC LIMIT 1`,
    )
    .get(key.vendorId, pair.src, pair.tgt, key.tier, utcDate(at)) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Every entry for a vendor, oldest effective date first, then oldest written. */
export function vendorRateHistory(
  db: Database.Database,
  vendorId: number,
): VendorRateEntry[] {
  return (
    db
      .prepare(
        'SELECT * FROM rate_card_entry WHERE vendor_id = ? ORDER BY effective_from, id',
      )
      .all(vendorId) as Row[]
  ).map(fromRow);
}

/**
 * The whole card as it stood on a date: for each pair and tier, the entry
 * in force then. Ordered by pair, then tier in `RATE_TIERS` order.
 */
export function vendorRateCardAt(
  db: Database.Database,
  vendorId: number,
  at: string | Date,
): VendorRateEntry[] {
  const day = utcDate(at);
  const rows = db
    .prepare(
      `SELECT r.* FROM rate_card_entry r
       WHERE r.vendor_id = ? AND r.effective_from <= ?
         AND r.id = (
           SELECT r2.id FROM rate_card_entry r2
           WHERE r2.vendor_id = r.vendor_id AND r2.src_lang = r.src_lang
             AND r2.tgt_lang = r.tgt_lang AND r2.tier = r.tier
             AND r2.effective_from <= ?
           ORDER BY r2.effective_from DESC, r2.id DESC LIMIT 1)
       ORDER BY r.src_lang, r.tgt_lang, r.id`,
    )
    .all(vendorId, day, day) as Row[];
  return rows.map(fromRow);
}
