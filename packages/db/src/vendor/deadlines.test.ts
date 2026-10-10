/** The deadline clock: reminders and overdue notices (issue #155; vendor-spec.md, its #155 note). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents } from '../audit/events.js';
import {
  acceptAssignment,
  addVendor,
  addWebhookEndpoint,
  createDirectOffer,
  createVendorFile,
  deliverAssignment,
  fireDeadlineNotices,
  getReminderLead,
  moveAssignment,
  nextNoticeAt,
  openVendorFile,
  setReminderLead,
  startAssignment,
} from './index.js';

const H = 3_600_000;
const DEADLINE = '2026-03-10T12:00:00.000Z';
const OFFERED = new Date('2026-03-01T10:00:00Z');
const at = (iso: string) => new Date(iso);
const owner = { ...TEST_ACTOR, label: 'owner' };
const who = { ...TEST_ACTOR, label: 'vendor' };

let dir: string;
let path: string;
let db: Database;
let ana: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-deadlines-'));
  path = join(dir, 'vendors.ctv');
  db = createVendorFile(path, { generator: 'test' });
  ana = addVendor(db, { accountId: 10, actor: TEST_ACTOR }).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const endpoint = () =>
  addWebhookEndpoint(db, {
    url: 'https://hooks.example.com/in',
    actor: owner,
    now: OFFERED,
  });
const job = (deadline: string | null = DEADLINE, now = OFFERED) =>
  createDirectOffer(db, { projectName: 'p', vendorId: ana, deadline, actor: owner, now });
const sent = () =>
  db
    .prepare('SELECT event_type AS type, body FROM webhook_delivery ORDER BY rowid')
    .all() as Array<{ type: string; body: string }>;
const notices = () =>
  db
    .prepare('SELECT assignment_id AS id, kind FROM assignment_notice ORDER BY rowid')
    .all() as Array<{ id: number; kind: string }>;

describe('the reminder lead', () => {
  it('is 24 hours until the owner sets one, and 0 turns reminders off', () => {
    expect(getReminderLead(db)).toBe(24);
    expect(setReminderLead(db, { hours: 0, actor: owner })).toBe(0);
    expect(getReminderLead(db)).toBe(0);
  });

  it('logs a change with the before and after, and nothing for the value already in force', () => {
    setReminderLead(db, { hours: 48, actor: owner });
    setReminderLead(db, { hours: 48, actor: owner });
    setReminderLead(db, { hours: 24, actor: owner });
    const log = listEvents(db, { subjectType: 'notice_setting' }).filter(
      (e) => e.action === 'webhook.reminder_changed',
    );
    expect(log.map((e) => JSON.parse(e.detail as string))).toEqual([
      { from: 24, to: 48 },
      { from: 48, to: 24 },
    ]);
  });

  it('refuses a lead that is not a whole number of hours from 0 to 720', () => {
    for (const hours of [-1, 721, 1.5, Number.NaN]) {
      expect(() => setReminderLead(db, { hours, actor: owner })).toThrow(/0 to 720/);
    }
    expect(getReminderLead(db)).toBe(24);
  });
});

describe('firing notices', () => {
  it('sends nothing before the reminder window, the reminder inside it, overdue after', () => {
    endpoint();
    const a = job();
    expect(fireDeadlineNotices(db, at('2026-03-09T11:59:59Z'))).toEqual({
      fired: 0,
      queued: 0,
    });
    expect(fireDeadlineNotices(db, at('2026-03-09T12:00:00Z'))).toEqual({
      fired: 1,
      queued: 1,
    });
    expect(fireDeadlineNotices(db, at('2026-03-10T12:00:01Z'))).toEqual({
      fired: 1,
      queued: 1,
    });
    const types = sent()
      .map((r) => r.type)
      .filter((t) => t !== 'assignment.offered');
    expect(types).toEqual(['assignment.deadline_soon', 'assignment.overdue']);
    expect(JSON.parse(sent().at(-1)!.body)).toMatchObject({
      type: 'assignment.overdue',
      assignmentId: a.id,
      from: null,
      to: 'offered',
      vendorAccountId: 10,
    });
  });

  it('fires each notice once, however often the clock runs', () => {
    endpoint();
    job();
    const late = at('2026-03-11T00:00:00Z');
    fireDeadlineNotices(db, late);
    const before = sent().length;
    expect(fireDeadlineNotices(db, late)).toEqual({ fired: 0, queued: 0 });
    expect(fireDeadlineNotices(db, at('2026-03-12T00:00:00Z'))).toEqual({
      fired: 0,
      queued: 0,
    });
    expect(sent()).toHaveLength(before);
  });

  it('survives a restart: a reopened file neither loses nor repeats a notice', () => {
    endpoint();
    job();
    fireDeadlineNotices(db, at('2026-03-09T13:00:00Z'));
    db.close();
    db = openVendorFile(path);
    expect(notices()).toEqual([{ id: 1, kind: 'deadline_soon' }]);
    expect(fireDeadlineNotices(db, at('2026-03-09T14:00:00Z')).fired).toBe(0);
    expect(fireDeadlineNotices(db, at('2026-03-10T13:00:00Z')).fired).toBe(1);
  });

  it('records a notice with no endpoint, so an endpoint added later gets no replay', () => {
    job();
    expect(fireDeadlineNotices(db, at('2026-03-11T00:00:00Z'))).toEqual({
      fired: 2,
      queued: 0,
    });
    endpoint();
    expect(fireDeadlineNotices(db, at('2026-03-12T00:00:00Z')).fired).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('records but does not send a reminder that comes due in the same pass as overdue', () => {
    endpoint();
    job();
    const result = fireDeadlineNotices(db, at('2026-03-11T00:00:00Z'));
    expect(result).toEqual({ fired: 2, queued: 1 });
    expect(sent().map((r) => r.type)).toEqual([
      'assignment.offered',
      'assignment.overdue',
    ]);
    expect(notices().map((n) => n.kind)).toEqual(['deadline_soon', 'overdue']);
  });

  it('skips a reminder for a job offered inside its own lead window', () => {
    endpoint();
    job('2026-03-01T20:00:00.000Z', OFFERED); // 10 h to go, lead 24 h
    fireDeadlineNotices(db, at('2026-03-01T11:00:00Z'));
    expect(notices()).toEqual([]);
    fireDeadlineNotices(db, at('2026-03-01T20:00:01Z'));
    expect(notices().map((n) => n.kind)).toEqual(['overdue']);
  });

  it('sends no reminder when the lead is off, but still sends overdue', () => {
    endpoint();
    job();
    setReminderLead(db, { hours: 0, actor: owner });
    fireDeadlineNotices(db, at('2026-03-10T00:00:00Z'));
    expect(notices()).toEqual([]);
    fireDeadlineNotices(db, at('2026-03-10T13:00:00Z'));
    expect(notices().map((n) => n.kind)).toEqual(['overdue']);
  });

  it('follows a changed lead: a longer one reminds earlier', () => {
    endpoint();
    job();
    setReminderLead(db, { hours: 72, actor: owner });
    fireDeadlineNotices(db, at('2026-03-07T12:00:00Z'));
    expect(notices().map((n) => n.kind)).toEqual(['deadline_soon']);
  });

  it('leaves a job with no deadline alone', () => {
    endpoint();
    job(null);
    expect(fireDeadlineNotices(db, at('2030-01-01T00:00:00Z')).fired).toBe(0);
  });

  it('stops for a job that was delivered, declined or never answered, by status', () => {
    endpoint();
    const done = job();
    acceptAssignment(db, {
      assignmentId: done.id,
      vendorId: ana,
      actor: who,
      now: OFFERED,
    });
    startAssignment(db, {
      assignmentId: done.id,
      vendorId: ana,
      actor: who,
      now: OFFERED,
    });
    deliverAssignment(db, {
      assignmentId: done.id,
      vendorId: ana,
      pair: { src: 'en', tgt: 'de' },
      actor: who,
      now: OFFERED,
    });
    const refused = job();
    moveAssignment(db, {
      assignmentId: refused.id,
      to: 'declined',
      by: 'vendor',
      vendorId: ana,
      actor: who,
      now: OFFERED,
    });
    const silent = job();
    fireDeadlineNotices(db, at('2026-03-11T00:00:00Z'));
    expect([...new Set(notices().map((n) => n.id))]).toEqual([silent.id]);
  });
});

describe('when the next notice is due', () => {
  it('is the reminder, then overdue, then nothing', () => {
    expect(nextNoticeAt(db)).toBeNull();
    job();
    expect(nextNoticeAt(db)).toBe(Date.parse(DEADLINE) - 24 * H);
    fireDeadlineNotices(db, at('2026-03-09T13:00:00Z'));
    expect(nextNoticeAt(db)).toBe(Date.parse(DEADLINE));
    fireDeadlineNotices(db, at('2026-03-10T13:00:00Z'));
    expect(nextNoticeAt(db)).toBeNull();
  });
});
