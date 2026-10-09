/**
 * Each vendor's record on one roster (`planning/vendor-spec.md`, its #123 note):
 * a count over the assignments and their `delivered` events, read when asked and
 * never stored, so it cannot disagree with the history it summarises. The counting
 * rules are `vendor-core`'s `vendorRecord`; this only gathers the rows.
 */
import { vendorRecord, type RecordRow, type VendorRecord } from '@cat-tool/vendor-core';
import type { Database } from 'better-sqlite3';

/**
 * The record of every vendor who holds an assignment, by vendor id. A vendor with no
 * assignment has no entry (their record is the empty one, `vendorRecord([])`). One query
 * for the whole roster: the first `delivered` event of each job rides along, through
 * `assignment_event_assignment`, so a roster of hundreds of jobs is not a query per job.
 */
export function vendorRecords(db: Database): Map<number, VendorRecord> {
  const rows = db
    .prepare(
      `SELECT a.vendor_id AS vendorId, a.status AS status, a.deadline AS deadline,
              (SELECT MIN(e.at) FROM assignment_event e
                WHERE e.assignment_id = a.id AND e.to_status = 'delivered') AS deliveredAt
         FROM assignment a
        WHERE a.vendor_id IS NOT NULL`,
    )
    .all() as Array<RecordRow & { vendorId: number }>;
  const byVendor = new Map<number, RecordRow[]>();
  for (const { vendorId, ...row } of rows) {
    const held = byVendor.get(vendorId);
    if (held) held.push(row);
    else byVendor.set(vendorId, [row]);
  }
  return new Map([...byVendor].map(([id, held]) => [id, vendorRecord(held)]));
}
