/**
 * A vendor's record (`planning/vendor-spec.md`, its #123 implementation note):
 * how many of the offers they answered they accepted, and how many of the jobs
 * they delivered came in by the deadline. Two counts, each with its sample size,
 * and deliberately never one score: a rate without its denominator, or a number
 * that ranks people, is what this must not become. Pure: rows in, counts out.
 * Which assignments a vendor holds and when their `delivered` event happened is `db`'s.
 */
import type { AssignmentStatus } from './assignment.js';

/** One assignment held by a vendor, as the record reads it. */
export interface RecordRow {
  readonly status: AssignmentStatus;
  /** The deadline as stored (an ISO instant), or null when the job had none. */
  readonly deadline: string | null;
  /** The time of the first `delivered` event, or null while it has none. */
  readonly deliveredAt: string | null;
}

/** The statuses that say the vendor said yes (an `accepted` job moves on from there). */
const ACCEPTED = new Set<AssignmentStatus>([
  'accepted',
  'in_progress',
  'delivered',
  'reviewed',
]);

/** A vendor's record. A count is a count of jobs; a sample of 0 has no rate. */
export interface VendorRecord {
  /** Offers the vendor accepted or declined; one still waiting for an answer is in neither. */
  readonly answered: number;
  readonly accepted: number;
  /** Delivered jobs that had a deadline: the sample the on-time count is out of. */
  readonly timed: number;
  /** Of `timed`, those whose first delivery was at or before the deadline. */
  readonly onTime: number;
  /** Every job delivered, with or without a deadline (`reviewed` ones included). */
  readonly delivered: number;
}

/** The instant of an ISO string, or null when it does not parse (a deadline is checked on write). */
const instant = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * The record of one vendor from the assignments they hold. A pool job nobody claimed is
 * not theirs and never appears here; one they claimed and declined counts once, as a
 * decline, because its repost went to the others as a new assignment. A direct offer
 * they ignored stays `offered` and is in no count: silence is not recorded as a "no".
 */
export function vendorRecord(rows: readonly RecordRow[]): VendorRecord {
  let accepted = 0;
  let declined = 0;
  let delivered = 0;
  let timed = 0;
  let onTime = 0;
  for (const row of rows) {
    if (ACCEPTED.has(row.status)) accepted += 1;
    else if (row.status === 'declined') declined += 1;
    if (row.status !== 'delivered' && row.status !== 'reviewed') continue;
    delivered += 1;
    const due = instant(row.deadline);
    const at = instant(row.deliveredAt);
    if (due === null || at === null) continue;
    timed += 1;
    if (at <= due) onTime += 1;
  }
  return { answered: accepted + declined, accepted, timed, onTime, delivered };
}
