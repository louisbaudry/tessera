/**
 * What the roster says about a vendor's record (backlog #123; `vendor-spec.md`, its
 * #123 note): the counts in words, each with the number it is out of. Never a
 * percentage on its own and never one figure for the person: a rate without its
 * sample is what this screen must not show, and nothing here ranks anyone. The
 * counting is `vendor-core`'s; this is only how a count reads.
 */
import type { VendorRecord } from '@cat-tool/vendor-core';

/** Said once beside the figures: they inform a person's choice, they never make it. */
export const RECORD_CAVEAT =
  'Counted from each job’s history. Small numbers say little, and a hard file or a tight deadline is not a bad vendor. Nothing here ranks or excludes anyone.';

const plural = (n: number, one: string, many: string): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "Accepted 4 of 5 offers answered", or why there is nothing to say yet. */
export function acceptanceLabel(record: VendorRecord): string {
  if (record.answered === 0) return 'No offer answered yet';
  return `Accepted ${record.accepted.toLocaleString()} of ${plural(record.answered, 'offer answered', 'offers answered')}`;
}

/**
 * "On time 3 of 4 deliveries with a deadline". A delivery that had no deadline is not in
 * that sample, and the label says so rather than showing a smaller number without a reason.
 */
export function onTimeLabel(record: VendorRecord): string {
  if (record.delivered === 0) return 'Nothing delivered yet';
  if (record.timed === 0) {
    return `${plural(record.delivered, 'delivery', 'deliveries')}, none with a deadline`;
  }
  const base = `On time ${record.onTime.toLocaleString()} of ${plural(record.timed, 'delivery', 'deliveries')} with a deadline`;
  const untimed = record.delivered - record.timed;
  return untimed === 0 ? base : `${base} (${untimed.toLocaleString()} without one)`;
}
