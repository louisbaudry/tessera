/**
 * Assignments in an owner's `.ctv` (vendor-spec.md §4, its #48
 * implementation note). The lifecycle's rules are `vendor-core`'s
 * (`transitionAssignment`); this is the storage around them, and the one
 * place a move is made.
 *
 * **`moveAssignment` is what makes a claim safe.** It takes the write lock
 * first (`BEGIN IMMEDIATE`), reads the row, asks `transitionAssignment`
 * whether the edge exists and whose it is, checks the acting vendor, then
 * writes with `UPDATE … WHERE status = <what it read>` and checks that one
 * row changed. Two vendors claiming one pool job resolve to one claim and
 * one rejection, on one connection or two: the second takes the lock after
 * the first has committed, reads `claimed`, and is refused. A read-then-write
 * in a deferred transaction would instead fail the loser with a raw
 * `SQLITE_BUSY`, which no route could tell from a real error.
 */

import { formatActor, type AuditActor } from '@cat-tool/core';
import {
  initialStatus,
  isRateTier,
  outsideClientPool,
  RATE_TIERS,
  transitionAssignment,
  type AssignmentChannel,
  type AssignmentParty,
  type AssignmentStatus,
  type RateTier,
  type TierWords,
} from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { getClientPool } from './client-pools.js';
import { VendorError } from './error.js';
import { getVendor } from './vendors.js';
import { assignmentWebhookEvent, enqueueWebhook } from './webhooks.js';

/** Another move got there first: a route answers 409. */
export class AssignmentConflictError extends VendorError {
  constructor(message: string) {
    super(message);
    this.name = 'AssignmentConflictError';
  }
}

/** The vendor may not do this to this assignment (not theirs, not in the pool): a route answers 404. */
export class AssignmentAccessError extends VendorError {
  constructor(message: string) {
    super(message);
    this.name = 'AssignmentAccessError';
  }
}

export interface Assignment {
  readonly id: number;
  readonly projectName: string;
  readonly channel: AssignmentChannel;
  readonly status: AssignmentStatus;
  /** Null only while `pool_open`. */
  readonly vendorId: number | null;
  readonly deadline: string | null;
  readonly instructions: string | null;
  /** The declined assignment this one reposted, for a pool job a vendor declined. */
  readonly reopenedFrom: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AssignmentEvent {
  readonly id: number;
  readonly assignmentId: number;
  readonly from: AssignmentStatus | null;
  readonly to: AssignmentStatus;
  readonly actor: string;
  readonly actorLabel: string | null;
  readonly note: string | null;
  readonly at: string;
}

interface Row {
  id: number;
  project_name: string;
  channel: AssignmentChannel;
  status: AssignmentStatus;
  vendor_id: number | null;
  deadline: string | null;
  instructions: string | null;
  reopened_from: number | null;
  created_at: string;
  updated_at: string;
}

const fromRow = (r: Row): Assignment => ({
  id: r.id,
  projectName: r.project_name,
  channel: r.channel,
  status: r.status,
  vendorId: r.vendor_id,
  deadline: r.deadline,
  instructions: r.instructions,
  reopenedFrom: r.reopened_from,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const NOTE_LIMIT = 2000;

function cleanText(text: string | null | undefined, what: string): string | null {
  const trimmed = text?.trim() ?? '';
  if (trimmed.length > NOTE_LIMIT) {
    throw new VendorError(`${what} is at most ${NOTE_LIMIT} characters`);
  }
  return trimmed === '' ? null : trimmed;
}

function cleanDeadline(deadline: string | null | undefined): string | null {
  if (deadline === null || deadline === undefined || deadline.trim() === '') return null;
  const d = deadline.trim();
  if (Number.isNaN(Date.parse(d))) throw new VendorError(`"${d}" is not a deadline`);
  return new Date(d).toISOString();
}

function cleanProject(name: string): string {
  if (name.trim() === '') throw new VendorError('an assignment names a project');
  return name.trim();
}

function appendEvent(
  db: Database.Database,
  options: {
    assignmentId: number;
    from: AssignmentStatus | null;
    to: AssignmentStatus;
    actor: AuditActor;
    note?: string | null;
    at: string;
  },
): void {
  db.prepare(
    `INSERT INTO assignment_event
       (assignment_id, from_status, to_status, actor, actor_label, note, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    options.assignmentId,
    options.from,
    options.to,
    formatActor(options.actor.actor),
    options.actor.label,
    options.note ?? null,
    options.at,
  );
  // The outbox row is written in the caller's transaction, beside the event it
  // reports, so a committed event is sent at least once (vendor-spec.md #125).
  enqueueWebhook(db, assignmentWebhookEvent(options), options.at);
}

export interface JobFields {
  readonly projectName: string;
  readonly deadline?: string | null;
  readonly instructions?: string | null;
  /**
   * The project's words by match tier, as they stand now: frozen with the
   * assignment (backlog #116). Omitted, none is recorded and the job has no
   * payable breakdown. A tier cannot be recovered later (an edit clears it).
   */
  readonly analysis?: TierWords;
  /** Who is offering it — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
  /**
   * The project's portal client, whose vendor pool the offer must keep to
   * (issue #403). Omitted, or with a null client, nothing is checked: a project
   * that is no client's work has no pool. The server always passes it.
   */
  readonly clientPool?: ClientPoolCheck;
  readonly now?: Date;
}

/** What an offer checks a client's vendor pool against (issue #403). */
export interface ClientPoolCheck {
  /** The project's portal client (`portal_client_setting`), or null for none. */
  readonly portalClientId: number | null;
  /**
   * The owner's explicit choice to offer outside the pool. Logged as
   * `client_pool.overridden` when it lets someone through; never a default.
   */
  readonly override?: boolean;
}

/**
 * An offer or a pool post names a vendor outside the project's client's pool
 * and the owner did not override it (issue #403). Nothing was written.
 */
export class ClientPoolError extends VendorError {
  /** The vendor ids (roster numbers, not account ids) the pool leaves out. */
  readonly outside: readonly number[];
  constructor(outside: readonly number[]) {
    super(
      `vendor${outside.length === 1 ? '' : 's'} ${outside.map((id) => `#${id}`).join(', ')} ` +
        "not in this client's pool: add them to it, or offer with the override",
    );
    this.name = 'ClientPoolError';
    this.outside = outside;
  }
}

/**
 * Holds an offer to the client's pool, inside the offer's transaction: throws
 * `ClientPoolError` for a vendor outside it without the override; with the
 * override, returns the ids it let through so the caller logs them once the
 * assignment has an id.
 */
function checkClientPool(
  db: Database.Database,
  check: ClientPoolCheck | undefined,
  vendorIds: readonly number[],
): { clientId: number; outside: number[] } | null {
  if (!check || check.portalClientId === null) return null;
  const outside = outsideClientPool(getClientPool(db, check.portalClientId), vendorIds);
  if (outside.length === 0) return null;
  if (check.override !== true) throw new ClientPoolError(outside);
  return { clientId: check.portalClientId, outside };
}

/** Records an owner's override of a client's pool (issue #403): ids only, never a name. */
function logPoolOverride(
  db: Database.Database,
  assignmentId: number,
  overridden: { clientId: number; outside: number[] },
  actor: AuditActor,
): void {
  appendAuditEvent(db, {
    actor,
    action: 'client_pool.overridden',
    subjectType: 'assignment',
    subjectId: String(assignmentId),
    detail: {
      assignment_id: assignmentId,
      client_id: overridden.clientId,
      vendor_ids: overridden.outside,
    },
  });
}

export interface DirectOfferOptions extends JobFields {
  readonly vendorId: number;
}

/** Pushes a job to one named vendor: born `offered`. */
export function createDirectOffer(
  db: Database.Database,
  options: DirectOfferOptions,
): Assignment {
  const at = (options.now ?? new Date()).toISOString();
  return db.transaction((): Assignment => {
    if (!getVendor(db, options.vendorId)) {
      throw new VendorError(`no vendor #${options.vendorId} on this roster`);
    }
    const overridden = checkClientPool(db, options.clientPool, [options.vendorId]);
    const status = initialStatus('direct');
    const info = db
      .prepare(
        `INSERT INTO assignment
           (project_name, channel, status, vendor_id, deadline, instructions, created_at, updated_at)
         VALUES (?, 'direct', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cleanProject(options.projectName),
        status,
        options.vendorId,
        cleanDeadline(options.deadline),
        cleanText(options.instructions, 'instructions'),
        at,
        at,
      );
    const id = info.lastInsertRowid as number;
    if (options.analysis) freezeAnalysis(db, id, options.analysis, at);
    appendEvent(db, {
      assignmentId: id,
      from: null,
      to: status,
      actor: options.actor,
      at,
    });
    if (overridden) logPoolOverride(db, id, overridden, options.actor);
    return getAssignment(db, id)!;
  })();
}

export interface PoolPostOptions extends JobFields {
  /** The vendors eligible to claim it; at least one. */
  readonly vendorIds: readonly number[];
}

/** Posts a job to a set of eligible vendors: born `pool_open`, with no vendor. */
export function postToPool(db: Database.Database, options: PoolPostOptions): Assignment {
  const ids = [...new Set(options.vendorIds)];
  if (ids.length === 0)
    throw new VendorError('a pool post needs at least one eligible vendor');
  const at = (options.now ?? new Date()).toISOString();
  return db.transaction((): Assignment => {
    for (const id of ids) {
      if (!getVendor(db, id)) throw new VendorError(`no vendor #${id} on this roster`);
    }
    const overridden = checkClientPool(db, options.clientPool, ids);
    const status = initialStatus('pool');
    const info = db
      .prepare(
        `INSERT INTO assignment
           (project_name, channel, status, vendor_id, deadline, instructions, created_at, updated_at)
         VALUES (?, 'pool', ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        cleanProject(options.projectName),
        status,
        cleanDeadline(options.deadline),
        cleanText(options.instructions, 'instructions'),
        at,
        at,
      );
    const id = info.lastInsertRowid as number;
    const member = db.prepare(
      'INSERT INTO assignment_pool_member (assignment_id, vendor_id) VALUES (?, ?)',
    );
    for (const vendorId of ids) member.run(id, vendorId);
    if (options.analysis) freezeAnalysis(db, id, options.analysis, at);
    appendEvent(db, {
      assignmentId: id,
      from: null,
      to: status,
      actor: options.actor,
      at,
    });
    if (overridden) logPoolOverride(db, id, overridden, options.actor);
    return getAssignment(db, id)!;
  })();
}

/** Records an analysis with an assignment, once: the table refuses an edit or a delete. */
function freezeAnalysis(
  db: Database.Database,
  assignmentId: number,
  words: TierWords,
  at: string,
): void {
  const insert = db.prepare(
    'INSERT INTO assignment_analysis (assignment_id, tier, words) VALUES (?, ?, ?)',
  );
  for (const tier of RATE_TIERS) {
    const n = words[tier] ?? 0;
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new VendorError(`words for ${tier} must be a non-negative integer`);
    }
    if (n > 0) insert.run(assignmentId, tier, n);
  }
  for (const key of Object.keys(words)) {
    if (!isRateTier(key)) throw new VendorError(`unknown rate tier "${key}"`);
  }
  db.prepare('UPDATE assignment SET analysed_at = ? WHERE id = ?').run(at, assignmentId);
}

/** A reposted job carries the analysis of the one it reposts: same project, same words. */
function copyAnalysis(db: Database.Database, from: number, to: number): void {
  const source = db
    .prepare('SELECT analysed_at FROM assignment WHERE id = ?')
    .get(from) as { analysed_at: string | null } | undefined;
  if (!source?.analysed_at) return;
  db.prepare(
    `INSERT INTO assignment_analysis (assignment_id, tier, words)
     SELECT ?, tier, words FROM assignment_analysis WHERE assignment_id = ?`,
  ).run(to, from);
  db.prepare('UPDATE assignment SET analysed_at = ? WHERE id = ?').run(
    source.analysed_at,
    to,
  );
}

export interface AssignmentAnalysis {
  /** When the words were counted: the offer's time. */
  readonly at: string;
  readonly words: TierWords;
}

/** The tier breakdown frozen with an assignment, or null if none was recorded. */
export function getAssignmentAnalysis(
  db: Database.Database,
  assignmentId: number,
): AssignmentAnalysis | null {
  const head = db
    .prepare('SELECT analysed_at FROM assignment WHERE id = ?')
    .get(assignmentId) as { analysed_at: string | null } | undefined;
  if (!head?.analysed_at) return null;
  const words: Partial<Record<RateTier, number>> = {};
  for (const r of db
    .prepare('SELECT tier, words FROM assignment_analysis WHERE assignment_id = ?')
    .all(assignmentId) as Array<{ tier: RateTier; words: number }>) {
    words[r.tier] = r.words;
  }
  return { at: head.analysed_at, words };
}

export function getAssignment(db: Database.Database, id: number): Assignment | null {
  const row = db.prepare('SELECT * FROM assignment WHERE id = ?').get(id) as
    Row | undefined;
  return row ? fromRow(row) : null;
}

/** The vendors eligible to claim a pool job (kept after it is claimed), by vendor id. */
export function listPoolMembers(db: Database.Database, assignmentId: number): number[] {
  return (
    db
      .prepare(
        'SELECT vendor_id FROM assignment_pool_member WHERE assignment_id = ? ORDER BY vendor_id',
      )
      .all(assignmentId) as Array<{ vendor_id: number }>
  ).map((r) => r.vendor_id);
}

/** The history of one assignment, oldest first. */
export function listAssignmentEvents(
  db: Database.Database,
  assignmentId: number,
): AssignmentEvent[] {
  return (
    db
      .prepare('SELECT * FROM assignment_event WHERE assignment_id = ? ORDER BY id')
      .all(assignmentId) as Array<{
      id: number;
      assignment_id: number;
      from_status: AssignmentStatus | null;
      to_status: AssignmentStatus;
      actor: string;
      actor_label: string | null;
      note: string | null;
      at: string;
    }>
  ).map((r) => ({
    id: r.id,
    assignmentId: r.assignment_id,
    from: r.from_status,
    to: r.to_status,
    actor: r.actor,
    actorLabel: r.actor_label,
    note: r.note,
    at: r.at,
  }));
}

export interface MoveOptions {
  readonly assignmentId: number;
  readonly to: AssignmentStatus;
  readonly by: AssignmentParty;
  /** For a vendor's move: the vendor acting, who must be the one on the row (or, to claim, in the pool). */
  readonly vendorId?: number;
  readonly actor: AuditActor;
  readonly note?: string | null;
  readonly now?: Date;
  /**
   * Runs inside the move's own transaction, after the status is changed and the
   * event written, so what it writes commits with the move or not at all
   * (backlog #120: the payable locked at delivery). Not a second way to move.
   */
  readonly afterMove?: (db: Database.Database, moved: Assignment, at: string) => void;
}

/**
 * The one place an assignment moves. Throws `InvalidAssignmentTransitionError`
 * or `AssignmentPartyError` (from `vendor-core`) for an edge that does not
 * exist or is the other party's, `AssignmentAccessError` when the vendor is
 * not the assignment's (or not in its pool), and `AssignmentConflictError`
 * when another move changed the status after it was read. A vendor's
 * decline of a claimed pool job reposts the job to the rest of the pool,
 * in the same transaction.
 */
export function moveAssignment(db: Database.Database, options: MoveOptions): Assignment {
  const at = (options.now ?? new Date()).toISOString();
  return db
    .transaction((): Assignment => {
      const before = getAssignment(db, options.assignmentId);
      if (!before)
        throw new AssignmentAccessError(`no assignment #${options.assignmentId}`);

      if (options.by === 'vendor') {
        if (options.vendorId === undefined) {
          throw new VendorError('a vendor’s move names the vendor making it');
        }
        // A claim is the pool's: any member may try it, whatever the status
        // now is (the loser of a race is told it was taken, not that it
        // does not exist). Every other move is the assignment's own vendor's,
        // so a member who lost cannot accept what someone else claimed.
        const allowed =
          options.to === 'claimed'
            ? listPoolMembers(db, before.id).includes(options.vendorId)
            : before.vendorId === options.vendorId;
        if (!allowed)
          throw new AssignmentAccessError(`no assignment #${options.assignmentId}`);
      }

      transitionAssignment(before.status, options.to, options.by);

      // The conditional write is the second wall: the transaction took the
      // write lock first (`.immediate()`), so the read above is not stale, and
      // this still changes a row only if the status is the one read.
      const claiming = options.to === 'claimed';
      const changed = db
        .prepare(
          `UPDATE assignment SET status = ?, vendor_id = ${claiming ? '?' : 'vendor_id'}, updated_at = ?
         WHERE id = ? AND status = ?`,
        )
        .run(
          ...(claiming
            ? [options.to, options.vendorId, at, before.id, before.status]
            : [options.to, at, before.id, before.status]),
        ).changes;
      if (changed !== 1) {
        throw new AssignmentConflictError(
          `assignment #${before.id} is no longer ${before.status}: another move came first`,
        );
      }
      appendEvent(db, {
        assignmentId: before.id,
        from: before.status,
        to: options.to,
        actor: options.actor,
        note: cleanText(options.note, 'a note'),
        at,
      });

      if (
        options.to === 'declined' &&
        before.status === 'claimed' &&
        before.channel === 'pool'
      ) {
        repostToRest(db, before, options.vendorId!, options.actor, at);
      }
      const moved = getAssignment(db, before.id)!;
      options.afterMove?.(db, moved, at);
      return moved;
    })
    .immediate();
}

/** A decline of a claimed pool job: the same job, posted to the pool minus the decliner. */
function repostToRest(
  db: Database.Database,
  declined: Assignment,
  decliner: number,
  actor: AuditActor,
  at: string,
): void {
  const rest = listPoolMembers(db, declined.id).filter((v) => v !== decliner);
  if (rest.length === 0) return;
  const status = initialStatus('pool');
  const id = db
    .prepare(
      `INSERT INTO assignment
         (project_name, channel, status, vendor_id, deadline, instructions, reopened_from,
          created_at, updated_at)
       VALUES (?, 'pool', ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      declined.projectName,
      status,
      declined.deadline,
      declined.instructions,
      declined.id,
      at,
      at,
    ).lastInsertRowid as number;
  const member = db.prepare(
    'INSERT INTO assignment_pool_member (assignment_id, vendor_id) VALUES (?, ?)',
  );
  for (const v of rest) member.run(id, v);
  copyAnalysis(db, declined.id, id);
  appendEvent(db, {
    assignmentId: id,
    from: null,
    to: status,
    actor,
    note: `reposted after #${declined.id} was declined`,
    at,
  });
}

type VendorMove = Omit<MoveOptions, 'to' | 'by'>;

/** A vendor claims a pool job. */
export const claimAssignment = (db: Database.Database, o: VendorMove) =>
  moveAssignment(db, { ...o, to: 'claimed', by: 'vendor' });

/** A vendor accepts an offer, or the job they claimed. */
export const acceptAssignment = (db: Database.Database, o: VendorMove) =>
  moveAssignment(db, { ...o, to: 'accepted', by: 'vendor' });

/** A vendor declines an offer, or the job they claimed. */
export const declineAssignment = (db: Database.Database, o: VendorMove) =>
  moveAssignment(db, { ...o, to: 'declined', by: 'vendor' });

/** Every assignment on the roster, newest first: the owner's list (backlog #51). */
export function listAssignments(db: Database.Database): Assignment[] {
  return (db.prepare('SELECT * FROM assignment ORDER BY id DESC').all() as Row[]).map(
    fromRow,
  );
}

/** Every assignment of a vendor's own, newest first: what their job feed (#50) reads. */
export function listAssignmentsFor(
  db: Database.Database,
  vendorId: number,
): Assignment[] {
  return (
    db
      .prepare('SELECT * FROM assignment WHERE vendor_id = ? ORDER BY id DESC')
      .all(vendorId) as Row[]
  ).map(fromRow);
}

/** The pool jobs a vendor could claim right now, newest first. */
export function listClaimable(db: Database.Database, vendorId: number): Assignment[] {
  return (
    db
      .prepare(
        `SELECT a.* FROM assignment a
         JOIN assignment_pool_member m ON m.assignment_id = a.id
         WHERE a.status = 'pool_open' AND m.vendor_id = ?
         ORDER BY a.id DESC`,
      )
      .all(vendorId) as Row[]
  ).map(fromRow);
}
