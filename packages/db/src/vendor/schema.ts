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
import type {
  AssignmentChannel,
  AssignmentStatus,
  CapacityStatus,
  RateTier,
} from '@cat-tool/vendor-core';

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

/** `assignment.status` and the event's statuses since v2: `ASSIGNMENT_STATUSES` as of backlog #48. */
const V2_ASSIGNMENT_STATUSES = [
  'offered',
  'pool_open',
  'claimed',
  'accepted',
  'declined',
  'in_progress',
  'delivered',
  'reviewed',
] as const satisfies readonly AssignmentStatus[];

/** `assignment.channel` since v2: `ASSIGNMENT_CHANNELS` as of backlog #48. */
const V2_ASSIGNMENT_CHANNELS = [
  'direct',
  'pool',
] as const satisfies readonly AssignmentChannel[];

/**
 * Assignments (vendor-spec.md §4, its #48 implementation note). One job
 * for one project of this owner; the `vendor` is null only while the job
 * is `pool_open`. `assignment_event` is the whole record of a transition,
 * with a required actor and append-only by trigger from the first
 * migration (audit-spec.md §8.2), `order_event`'s way.
 */
const v2: Migration = {
  version: 2,
  description: 'assignment, assignment_pool_member, assignment_event (backlog #48)',
  up: (db) => {
    db.exec(`
      CREATE TABLE assignment (
        id            INTEGER PRIMARY KEY,
        project_name  TEXT    NOT NULL,
        channel       TEXT    NOT NULL CHECK (channel IN (${sqlList(V2_ASSIGNMENT_CHANNELS)})),
        status        TEXT    NOT NULL CHECK (status IN (${sqlList(V2_ASSIGNMENT_STATUSES)})),
        vendor_id     INTEGER REFERENCES vendor(id),
        deadline      TEXT,
        instructions  TEXT,
        reopened_from INTEGER REFERENCES assignment(id),
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL,
        -- A pool job has no vendor until one claims it; every other status has one.
        CHECK ((status = 'pool_open') = (vendor_id IS NULL))
      );
      CREATE INDEX assignment_vendor ON assignment(vendor_id, status);
      CREATE INDEX assignment_project ON assignment(project_name);

      -- The vendors eligible to claim a pool job. Kept after the claim:
      -- the record of who could have.
      CREATE TABLE assignment_pool_member (
        assignment_id INTEGER NOT NULL REFERENCES assignment(id),
        vendor_id     INTEGER NOT NULL REFERENCES vendor(id),
        PRIMARY KEY (assignment_id, vendor_id)
      ) WITHOUT ROWID;

      CREATE TABLE assignment_event (
        id            INTEGER PRIMARY KEY,
        assignment_id INTEGER NOT NULL REFERENCES assignment(id),
        from_status   TEXT CHECK (from_status IN (${sqlList(V2_ASSIGNMENT_STATUSES)})),
        to_status     TEXT NOT NULL CHECK (to_status IN (${sqlList(V2_ASSIGNMENT_STATUSES)})),
        actor         TEXT NOT NULL,
        actor_label   TEXT,
        note          TEXT,
        at            TEXT NOT NULL
      );
      CREATE INDEX assignment_event_assignment ON assignment_event(assignment_id, id);

      CREATE TRIGGER assignment_event_no_delete BEFORE DELETE ON assignment_event BEGIN
        SELECT RAISE(ABORT, 'assignment_event is append-only');
      END;
      -- The one permitted UPDATE: erasing a person's display label, as
      -- audit_event's trigger allows (audit-spec.md §5).
      CREATE TRIGGER assignment_event_no_update BEFORE UPDATE ON assignment_event
      WHEN NEW.id IS NOT OLD.id OR NEW.assignment_id IS NOT OLD.assignment_id
        OR NEW.from_status IS NOT OLD.from_status OR NEW.to_status IS NOT OLD.to_status
        OR NEW.actor IS NOT OLD.actor OR NEW.note IS NOT OLD.note OR NEW.at IS NOT OLD.at
        OR NEW.actor_label IS NOT '[erased]'
      BEGIN SELECT RAISE(ABORT, 'assignment_event is append-only'); END;
    `);
  },
};

/** `assignment_analysis.tier` since v3: `RATE_TIERS` as of backlog #116 (provisional, see vendor-spec §5). */
const V3_RATE_TIERS = [
  'no_match',
  'fuzzy_50_74',
  'fuzzy_75_84',
  'fuzzy_85_94',
  'fuzzy_95_99',
  'exact',
  'ice',
] as const satisfies readonly RateTier[];

/**
 * The match-tier analysis frozen with an assignment (vendor-spec.md decision
 * 10, backlog #116): words per tier as they stood when the job was offered.
 * A segment's tier cannot be read later, because an edit clears its origin,
 * so this is the only place the payable's words can come from. Immutable by
 * trigger: a re-analysis is a new assignment, never an edit. A tier with no
 * words has no row; `analysed_at` says an analysis was made at all (an empty
 * project has no rows and is still analysed).
 */
const v3: Migration = {
  version: 3,
  description: 'assignment_analysis: the tier breakdown frozen at offer (backlog #116)',
  up: (db) => {
    db.exec(`
      ALTER TABLE assignment ADD COLUMN analysed_at TEXT;

      CREATE TABLE assignment_analysis (
        assignment_id INTEGER NOT NULL REFERENCES assignment(id),
        tier          TEXT    NOT NULL CHECK (tier IN (${sqlList(V3_RATE_TIERS)})),
        words         INTEGER NOT NULL CHECK (words > 0),
        PRIMARY KEY (assignment_id, tier)
      ) WITHOUT ROWID;

      CREATE TRIGGER assignment_analysis_no_update BEFORE UPDATE ON assignment_analysis
      BEGIN SELECT RAISE(ABORT, 'assignment_analysis is frozen at offer'); END;
      CREATE TRIGGER assignment_analysis_no_delete BEFORE DELETE ON assignment_analysis
      BEGIN SELECT RAISE(ABORT, 'assignment_analysis is frozen at offer'); END;
    `);
  },
};

/** `assignment_payable_line.tier` since v4: `RATE_TIERS` as of backlog #120 (provisional, see vendor-spec §5). */
const V4_RATE_TIERS = [
  'no_match',
  'fuzzy_50_74',
  'fuzzy_75_84',
  'fuzzy_85_94',
  'fuzzy_95_99',
  'exact',
  'ice',
] as const satisfies readonly RateTier[];

/**
 * The payable locked at delivery (vendor-spec.md decision 10 and its #120
 * note): the amount and its lines, written in the delivery's own transaction
 * and immutable by trigger. A tier with no rate has a null rate and no
 * amount, and `complete = 0` says the vendor was not fully priced. A job
 * delivered with nothing to price has no row at all.
 */
const v4: Migration = {
  version: 4,
  description:
    'assignment_payable and its lines: the payable locked at delivery (backlog #120)',
  up: (db) => {
    db.exec(`
      CREATE TABLE assignment_payable (
        assignment_id INTEGER PRIMARY KEY REFERENCES assignment(id),
        currency      TEXT,
        words         INTEGER NOT NULL CHECK (words >= 0),
        total_micros  INTEGER NOT NULL CHECK (total_micros >= 0),
        complete      INTEGER NOT NULL,
        locked_at     TEXT    NOT NULL
      );

      CREATE TABLE assignment_payable_line (
        assignment_id INTEGER NOT NULL REFERENCES assignment(id),
        tier          TEXT    NOT NULL CHECK (tier IN (${sqlList(V4_RATE_TIERS)})),
        words         INTEGER NOT NULL CHECK (words > 0),
        rate_micros   INTEGER CHECK (rate_micros IS NULL OR rate_micros >= 0),
        amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
        PRIMARY KEY (assignment_id, tier)
      ) WITHOUT ROWID;

      CREATE TRIGGER assignment_payable_no_update BEFORE UPDATE ON assignment_payable
      BEGIN SELECT RAISE(ABORT, 'assignment_payable is locked at delivery'); END;
      CREATE TRIGGER assignment_payable_no_delete BEFORE DELETE ON assignment_payable
      BEGIN SELECT RAISE(ABORT, 'assignment_payable is locked at delivery'); END;
      CREATE TRIGGER assignment_payable_line_no_update BEFORE UPDATE ON assignment_payable_line
      BEGIN SELECT RAISE(ABORT, 'assignment_payable is locked at delivery'); END;
      CREATE TRIGGER assignment_payable_line_no_delete BEFORE DELETE ON assignment_payable_line
      BEGIN SELECT RAISE(ABORT, 'assignment_payable is locked at delivery'); END;
    `);
  },
};

export const VENDOR_MIGRATIONS: readonly Migration[] = [v1, v2, v3, v4];
