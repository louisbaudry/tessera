/**
 * The deadline clock's rules (`planning/vendor-spec.md`, its #155 note): which
 * notice an assignment is due for at an instant, and when the next one falls.
 * Pure: the repository reads the rows and writes the notices, the server's
 * dispatcher decides when to look.
 */
import type { AssignmentStatus } from './assignment.js';

/** The two notices a deadline produces. A frozen literal in the vendor schema's v7 migration. */
export const DEADLINE_NOTICE_KINDS = ['deadline_soon', 'overdue'] as const;
export type DeadlineNoticeKind = (typeof DEADLINE_NOTICE_KINDS)[number];

/** Hours of warning when the owner has not chosen: no `notice_setting` row means this. */
export const DEFAULT_REMINDER_LEAD_HOURS = 24;
/** The longest lead: 30 days. */
export const MAX_REMINDER_LEAD_HOURS = 720;

/** Statuses in which a deadline can still be missed: everything before delivery, except a decline. */
const OPEN: ReadonlySet<AssignmentStatus> = new Set([
  'offered',
  'pool_open',
  'claimed',
  'accepted',
  'in_progress',
]);

/** True while the job has not been delivered or declined, so its deadline can still be missed. */
export const canBeLate = (status: AssignmentStatus): boolean => OPEN.has(status);

/** Whether `hours` is a lead the owner may set: a whole number from 0 (off) to 30 days. */
export const isReminderLead = (hours: unknown): hours is number =>
  typeof hours === 'number' &&
  Number.isInteger(hours) &&
  hours >= 0 &&
  hours <= MAX_REMINDER_LEAD_HOURS;

/** What the clock needs to know about one assignment. */
export interface DeadlineRow {
  readonly status: AssignmentStatus;
  /** The deadline as stored (an ISO instant), or null when the job had none. */
  readonly deadline: string | null;
  /** When the assignment was created (ISO). */
  readonly createdAt: string;
}

const instant = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * The instant each notice becomes due for this assignment, or null when it never
 * will. `deadline_soon` is `lead` hours before the deadline, and is skipped when
 * the lead is off or when the job was created inside its own lead window (the
 * owner set that deadline knowing it, so a reminder at the moment of offer is
 * noise). `overdue` is the deadline itself.
 */
export function noticeTimes(
  row: DeadlineRow,
  leadHours: number,
): Record<DeadlineNoticeKind, number | null> {
  const due = instant(row.deadline);
  if (due === null || !canBeLate(row.status)) {
    return { deadline_soon: null, overdue: null };
  }
  const created = instant(row.createdAt);
  const soon = due - leadHours * 3_600_000;
  const skipSoon = leadHours === 0 || (created !== null && created > soon);
  return { deadline_soon: skipSoon ? null : soon, overdue: due };
}

/** The notices due at `now`, in the order they fall, leaving out any in `fired`. */
export function noticesDue(
  row: DeadlineRow,
  leadHours: number,
  now: number,
  fired: ReadonlySet<DeadlineNoticeKind>,
): DeadlineNoticeKind[] {
  const times = noticeTimes(row, leadHours);
  return DEADLINE_NOTICE_KINDS.filter((kind) => {
    const at = times[kind];
    return at !== null && at <= now && !fired.has(kind);
  });
}

/** The earliest moment any notice of this assignment becomes due and has not fired, or null. */
export function nextNoticeTime(
  row: DeadlineRow,
  leadHours: number,
  fired: ReadonlySet<DeadlineNoticeKind>,
): number | null {
  const times = noticeTimes(row, leadHours);
  let next: number | null = null;
  for (const kind of DEADLINE_NOTICE_KINDS) {
    const at = times[kind];
    if (at === null || fired.has(kind)) continue;
    if (next === null || at < next) next = at;
  }
  return next;
}
