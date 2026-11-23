/**
 * A calendar date, `YYYY-MM-DD`: a day, not an instant (no time, no zone), so it
 * means the same day wherever it is read. The one definition: the portal's due
 * dates (issue #179) and a vendor's time off (issue #156) both use it.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether a string is a real calendar date written `YYYY-MM-DD` (`2026-02-29` is not). */
export function isCalendarDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/** The UTC calendar date of an instant: the server's "today" when no one says theirs. */
export function utcCalendarDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}
