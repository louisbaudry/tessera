/**
 * A vendor's capacity (vendor-spec.md decision 8): a status they flip and a
 * note, the current one only. Not audited: a toggle changed many times a
 * day is not a change that matters, and a log of it is the capacity
 * history decision 8 declines to build.
 */

import {
  isCapacityStatus,
  parseTimeOff,
  type CapacityStatus,
  type DateWindow,
} from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';

import { VendorError } from './error.js';

export interface Capacity {
  readonly vendorId: number;
  readonly status: CapacityStatus;
  readonly note: string | null;
  readonly setAt: string;
  /** The account that set it: the vendor's own, or an owner's on their behalf. */
  readonly setBy: number | null;
}

const NOTE_LIMIT = 500;

export interface SetCapacityOptions {
  readonly vendorId: number;
  readonly status: CapacityStatus;
  readonly note?: string | null;
  readonly setBy?: number | null;
  readonly now?: Date;
}

/** Sets the vendor's status, replacing the last. */
export function setCapacity(
  db: Database.Database,
  options: SetCapacityOptions,
): Capacity {
  if (!isCapacityStatus(options.status)) {
    throw new VendorError(`unknown capacity status "${String(options.status)}"`);
  }
  const note = options.note?.trim() ?? '';
  if (note.length > NOTE_LIMIT) {
    throw new VendorError(`a capacity note is at most ${NOTE_LIMIT} characters`);
  }
  return db.transaction((): Capacity => {
    if (!db.prepare('SELECT 1 FROM vendor WHERE id = ?').get(options.vendorId)) {
      throw new VendorError(`no vendor #${options.vendorId}`);
    }
    db.prepare(
      `INSERT INTO capacity (vendor_id, status, note, set_at, set_by)
       VALUES (@vendor_id, @status, @note, @set_at, @set_by)
       ON CONFLICT (vendor_id) DO UPDATE SET
         status = excluded.status, note = excluded.note,
         set_at = excluded.set_at, set_by = excluded.set_by`,
    ).run({
      vendor_id: options.vendorId,
      status: options.status,
      note: note === '' ? null : note,
      set_at: (options.now ?? new Date()).toISOString(),
      set_by: options.setBy ?? null,
    });
    return getCapacity(db, options.vendorId)!;
  })();
}

/** The current status, or null if the vendor has never set one. */
export function getCapacity(db: Database.Database, vendorId: number): Capacity | null {
  const row = db.prepare('SELECT * FROM capacity WHERE vendor_id = ?').get(vendorId) as
    | {
        vendor_id: number;
        status: CapacityStatus;
        note: string | null;
        set_at: string;
        set_by: number | null;
      }
    | undefined;
  return row
    ? {
        vendorId: row.vendor_id,
        status: row.status,
        note: row.note,
        setAt: row.set_at,
        setBy: row.set_by,
      }
    : null;
}

/**
 * Replaces the vendor's time off with `windows` (issue #156): the list as it stands,
 * not an edit of one window, so the vendor's screen sends what it shows. Checked by
 * `parseTimeOff` here too, so no caller can store a backwards or unreal date. Not
 * audited, as capacity is not.
 *
 * @throws {VendorError} for an unknown vendor or a list `parseTimeOff` refuses
 */
export function setTimeOff(
  db: Database.Database,
  vendorId: number,
  windows: readonly DateWindow[],
): DateWindow[] {
  const parsed = parseTimeOff(windows);
  if (typeof parsed === 'string') throw new VendorError(parsed);
  return db.transaction((): DateWindow[] => {
    if (!db.prepare('SELECT 1 FROM vendor WHERE id = ?').get(vendorId)) {
      throw new VendorError(`no vendor #${vendorId}`);
    }
    db.prepare('DELETE FROM time_off WHERE vendor_id = ?').run(vendorId);
    const insert = db.prepare(
      'INSERT OR IGNORE INTO time_off (vendor_id, starts_on, ends_on) VALUES (?, ?, ?)',
    );
    for (const w of parsed) insert.run(vendorId, w.from, w.to);
    return getTimeOff(db, vendorId);
  })();
}

/**
 * The vendor's time off in date order; with `endingFrom`, only the periods that end
 * on or after that day (what is still to come, for the vendor's screen).
 */
export function getTimeOff(
  db: Database.Database,
  vendorId: number,
  options: { readonly endingFrom?: string } = {},
): DateWindow[] {
  const rows = db
    .prepare(
      `SELECT starts_on, ends_on FROM time_off
        WHERE vendor_id = @vendorId AND ends_on >= @from
        ORDER BY starts_on, ends_on`,
    )
    .all({ vendorId, from: options.endingFrom ?? '' }) as Array<{
    starts_on: string;
    ends_on: string;
  }>;
  return rows.map((r) => ({ from: r.starts_on, to: r.ends_on }));
}
