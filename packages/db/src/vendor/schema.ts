/**
 * `.ctv` vendor roster schema (`planning/vendor-spec.md` §5 and its #46
 * implementation note; backlog #46).
 *
 * One file per **owner** account, holding the vendors that owner engages
 * and what they pay them. Every closed set is a frozen literal, never the
 * live constant (`db/migrate.ts`, backlog #64): `RATE_TIERS`,
 * `CAPACITY_STATUSES` and `VENDOR_AUDIT_ACTIONS`, tied to the newest
 * snapshot by `db/check-lists.test.ts`.
 *
 * A rate is a row and never an edit: `rate_card_entry` is append-only by
 * trigger from this first migration, because a history that any caller
 * with the connection could rewrite is not one a payable can rest on.
 */

import type { VendorAuditAction } from '@cat-tool/core';
import type { CapacityStatus, RateTier } from '@cat-tool/vendor-core';

import { auditEventDdl } from '../audit/events.js';
import { sqlList, type Migration } from '../migrate.js';

/** "CATV" — distinct from "CATM", "CATG", "CATP", "CATO" and the platform's "CATL". */
export const VENDOR_APPLICATION_ID = 0x43415456;

/** `rate_card_entry.tier` since v1: `RATE_TIERS` as of backlog #46 (provisional, see vendor-spec §5). */
const V1_RATE_TIERS = [
  'no_match',
  'fuzzy_50_74',
  'fuzzy_75_84',
  'fuzzy_85_94',
  'fuzzy_95_99',
  'exact',
  'ice',
] as const satisfies readonly RateTier[];

/** `capacity.status` since v1: `CAPACITY_STATUSES` as of backlog #46. */
const V1_CAPACITY_STATUSES = [
  'available',
  'busy',
  'away',
] as const satisfies readonly CapacityStatus[];

/** `audit_event.action` since v1: `VENDOR_AUDIT_ACTIONS` as of backlog #46. */
const V1_AUDIT_ACTIONS = [
  'vendor.added',
  'vendor.profile_changed',
  'vendor.rate_set',
] as const satisfies readonly VendorAuditAction[];

const v1: Migration = {
  version: 1,
  description: 'initial vendor roster schema (vendor-spec.md §5, backlog #46)',
  up: (db) => {
    db.exec(`
      CREATE TABLE vendor_file (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        uuid           TEXT    NOT NULL UNIQUE,
        created_at     TEXT    NOT NULL,
        format_version INTEGER NOT NULL,
        generator      TEXT    NOT NULL
      );

      -- A vendor is a roster entry keyed by its platform account. The
      -- account id is installation-local, like an audit actor id; the
      -- email stays in the account, never copied here.
      CREATE TABLE vendor (
        id           INTEGER PRIMARY KEY,
        account_id   INTEGER NOT NULL UNIQUE,
        display_name TEXT,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL
      );

      -- Language pairs by primary subtag: en-GB and en-US into de are one pair.
      CREATE TABLE vendor_language (
        vendor_id INTEGER NOT NULL REFERENCES vendor(id),
        src_lang  TEXT    NOT NULL,
        tgt_lang  TEXT    NOT NULL,
        PRIMARY KEY (vendor_id, src_lang, tgt_lang)
      ) WITHOUT ROWID;

      CREATE TABLE vendor_specialty (
        vendor_id INTEGER NOT NULL REFERENCES vendor(id),
        tag       TEXT    NOT NULL,
        PRIMARY KEY (vendor_id, tag)
      ) WITHOUT ROWID;

      -- The rate in force at a date is the latest entry effective on or
      -- before it. Money is an integer: millionths of a currency unit per word.
      CREATE TABLE rate_card_entry (
        id             INTEGER PRIMARY KEY,
        vendor_id      INTEGER NOT NULL REFERENCES vendor(id),
        src_lang       TEXT    NOT NULL,
        tgt_lang       TEXT    NOT NULL,
        tier           TEXT    NOT NULL CHECK (tier IN (${sqlList(V1_RATE_TIERS)})),
        rate_micros    INTEGER NOT NULL CHECK (rate_micros >= 0),
        currency       TEXT    NOT NULL CHECK (length(currency) = 3),
        effective_from TEXT    NOT NULL CHECK (length(effective_from) = 10),
        created_at     TEXT    NOT NULL
      );
      CREATE INDEX rate_card_lookup
        ON rate_card_entry(vendor_id, src_lang, tgt_lang, tier, effective_from, id);

      CREATE TRIGGER rate_card_entry_no_update BEFORE UPDATE ON rate_card_entry BEGIN
        SELECT RAISE(ABORT, 'rate_card_entry is append-only');
      END;
      CREATE TRIGGER rate_card_entry_no_delete BEFORE DELETE ON rate_card_entry BEGIN
        SELECT RAISE(ABORT, 'rate_card_entry is append-only');
      END;

      -- One row per vendor, the current status only (decision 8).
      CREATE TABLE capacity (
        vendor_id INTEGER PRIMARY KEY REFERENCES vendor(id),
        status    TEXT    NOT NULL CHECK (status IN (${sqlList(V1_CAPACITY_STATUSES)})),
        note      TEXT,
        set_at    TEXT    NOT NULL,
        set_by    INTEGER
      );
    `);
    db.exec(auditEventDdl(V1_AUDIT_ACTIONS));
  },
};

export const VENDOR_MIGRATIONS: readonly Migration[] = [v1];
