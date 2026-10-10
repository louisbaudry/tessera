/**
 * The deadline clock's repository (`planning/vendor-spec.md`, its #155 note): the
 * owner's reminder lead, and the pass that turns an approaching or missed
 * deadline into a recorded notice and a webhook delivery. The rules for which
 * notice is due are `vendor-core`'s (`deadline.ts`); this module reads the
 * assignments, writes `assignment_notice` and queues the deliveries in one
 * transaction, so a notice fires once, survives a restart, and a crash between
 * the record and the queue can neither lose it nor repeat it.
 */
import type { AuditActor } from '@cat-tool/core';
import {
  DEFAULT_REMINDER_LEAD_HOURS,
  isReminderLead,
  nextNoticeTime,
  noticesDue,
  type AssignmentStatus,
  type DeadlineNoticeKind,
  type DeadlineRow,
} from '@cat-tool/vendor-core';
import { eventForNotice } from '@cat-tool/vendor-core/webhook';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { VendorError } from './error.js';
import { enqueueWebhook } from './webhooks.js';

/** The reminder lead in hours: the owner's row, else the default. 0 means reminders are off. */
export function getReminderLead(db: Database.Database): number {
  const row = db
    .prepare('SELECT reminder_lead_hours AS hours FROM notice_setting WHERE id = 1')
    .get() as { hours: number } | undefined;
  return row?.hours ?? DEFAULT_REMINDER_LEAD_HOURS;
}

/**
 * Sets how many hours before a deadline the reminder goes (0 turns it off).
 * Logged as `webhook.reminder_changed` with the before and after; a value equal
 * to the one in force writes nothing.
 *
 * @throws VendorError for anything but a whole number from 0 to 720.
 */
export function setReminderLead(
  db: Database.Database,
  options: { readonly hours: number; readonly actor: AuditActor },
): number {
  if (!isReminderLead(options.hours)) {
    throw new VendorError('the reminder lead is a whole number of hours from 0 to 720');
  }
  return db.transaction(() => {
    const from = getReminderLead(db);
    if (from === options.hours) return from;
    db.prepare(
      `INSERT INTO notice_setting (id, reminder_lead_hours) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET reminder_lead_hours = excluded.reminder_lead_hours`,
    ).run(options.hours);
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'webhook.reminder_changed',
      subjectType: 'notice_setting',
      subjectId: '1',
      detail: { from, to: options.hours },
    });
    return options.hours;
  })();
}

interface OpenRow extends DeadlineRow {
  readonly id: number;
}

/** Jobs that carry a deadline and have not been delivered or declined. */
function openWithDeadline(db: Database.Database): OpenRow[] {
  return db
    .prepare(
      `SELECT id, status, deadline, created_at AS createdAt FROM assignment
        WHERE deadline IS NOT NULL
          AND status IN ('offered', 'pool_open', 'claimed', 'accepted', 'in_progress')`,
    )
    .all() as OpenRow[];
}

function firedByAssignment(db: Database.Database): Map<number, Set<DeadlineNoticeKind>> {
  const rows = db
    .prepare('SELECT assignment_id AS id, kind FROM assignment_notice')
    .all() as Array<{ id: number; kind: DeadlineNoticeKind }>;
  const fired = new Map<number, Set<DeadlineNoticeKind>>();
  for (const r of rows) {
    const set = fired.get(r.id) ?? new Set<DeadlineNoticeKind>();
    set.add(r.kind);
    fired.set(r.id, set);
  }
  return fired;
}

/** What one pass of the clock did. */
export interface NoticePass {
  /** Notices recorded as fired (including a reminder superseded by `overdue`). */
  readonly fired: number;
  /** Webhook deliveries queued for them. */
  readonly queued: number;
}

/**
 * Fires every notice that is due at `now`. Each (assignment, kind) is recorded
 * once, whether or not an endpoint exists: adding an endpoint later does not
 * replay lateness. A reminder that comes due in the same pass as `overdue` (the
 * server was down across the deadline) is recorded but not sent, since "due in
 * a day" after the deadline has passed would be false.
 */
export function fireDeadlineNotices(db: Database.Database, now: Date): NoticePass {
  return db.transaction(() => {
    const lead = getReminderLead(db);
    const fired = firedByAssignment(db);
    const at = now.toISOString();
    let count = 0;
    let queued = 0;
    for (const row of openWithDeadline(db)) {
      const due = noticesDue(row, lead, now.getTime(), fired.get(row.id) ?? new Set());
      for (const kind of due) {
        db.prepare(
          'INSERT INTO assignment_notice (assignment_id, kind, fired_at) VALUES (?, ?, ?)',
        ).run(row.id, kind, at);
        count += 1;
        if (kind === 'deadline_soon' && due.includes('overdue')) continue;
        queued += enqueueWebhook(
          db,
          {
            type: eventForNotice(kind),
            at,
            assignmentId: row.id,
            from: null,
            to: row.status as AssignmentStatus,
          },
          at,
        );
      }
    }
    return { fired: count, queued };
  })();
}

/**
 * When the next notice becomes due (epoch milliseconds), or null when no job has
 * one ahead. The dispatcher uses it to leave a roster closed until then.
 */
export function nextNoticeAt(db: Database.Database): number | null {
  const lead = getReminderLead(db);
  const fired = firedByAssignment(db);
  let next: number | null = null;
  for (const row of openWithDeadline(db)) {
    const at = nextNoticeTime(row, lead, fired.get(row.id) ?? new Set());
    if (at !== null && (next === null || at < next)) next = at;
  }
  return next;
}
