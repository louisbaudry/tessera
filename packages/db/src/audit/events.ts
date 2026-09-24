/**
 * `audit_event` storage (`planning/audit-spec.md` §2, §7; backlog #56).
 *
 * One table definition, one writer and one set of reads for every
 * database that keeps a log — `project.catdb` first, `platform.sqlite`
 * and `portal.sqlite` next (#57/#58). The row type, action vocabulary
 * and hash are `core/audit`'s; this module is only the SQL around them.
 * A second hand-written copy of the DDL in another schema file is the
 * mistake `qualifySchema` was moved to prevent.
 */

import {
  chainHash,
  formatActor,
  genesisHash,
  verifyAuditChain,
  type AuditAction,
  type AuditActor,
  type AuditDetail,
  type AuditEventRow,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

const sqlList = (values: readonly string[]): string =>
  values.map((v) => `'${v}'`).join(', ');

/**
 * The table, its indexes and its append-only triggers (spec §2), with
 * `action` CHECKed against the actions that can happen in this file.
 * A new action is a migration that widens the CHECK, never free text.
 */
export function auditEventDdl(actions: readonly AuditAction[]): string {
  return `
    CREATE TABLE audit_event (
      id           INTEGER PRIMARY KEY,
      at           TEXT    NOT NULL,
      actor        TEXT    NOT NULL,
      actor_label  TEXT,
      action       TEXT    NOT NULL CHECK (action IN (${sqlList(actions)})),
      subject_type TEXT    NOT NULL,
      subject_id   TEXT,
      batch_id     INTEGER REFERENCES audit_event(id),
      detail       TEXT,
      chain_hash   TEXT    NOT NULL
    );
    CREATE INDEX audit_event_subject ON audit_event(subject_type, subject_id, id);
    CREATE INDEX audit_event_batch   ON audit_event(batch_id) WHERE batch_id IS NOT NULL;

    CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event
    BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;

    -- The one permitted UPDATE: erasing a person's display label (spec §5).
    -- actor_label is outside the chain for exactly this reason.
    CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event
    WHEN NEW.id IS NOT OLD.id OR NEW.at IS NOT OLD.at
      OR NEW.actor IS NOT OLD.actor OR NEW.action IS NOT OLD.action
      OR NEW.subject_type IS NOT OLD.subject_type OR NEW.subject_id IS NOT OLD.subject_id
      OR NEW.batch_id IS NOT OLD.batch_id OR NEW.detail IS NOT OLD.detail
      OR NEW.chain_hash IS NOT OLD.chain_hash
      OR NEW.actor_label IS NOT '[erased]'
    BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;
  `;
}

export interface NewAuditEvent<A extends AuditAction> {
  readonly actor: AuditActor;
  readonly action: A;
  readonly subjectType: string;
  readonly subjectId: string | null;
  /** The batch-level parent event (spec §2.3), if this row is one of its children. */
  readonly batchId?: number | null;
  readonly detail: AuditDetail[A];
}

interface EventRow {
  id: number;
  at: string;
  actor: string;
  actor_label: string | null;
  action: string;
  subject_type: string;
  subject_id: string | null;
  batch_id: number | null;
  detail: string | null;
  chain_hash: string;
}

const fromRow = (row: EventRow): AuditEventRow => ({
  id: row.id,
  at: row.at,
  actor: row.actor,
  actorLabel: row.actor_label,
  action: row.action,
  subjectType: row.subject_type,
  subjectId: row.subject_id,
  batchId: row.batch_id,
  detail: row.detail,
  chainHash: row.chain_hash,
});

const applicationId = (db: Database.Database): number =>
  db.pragma('application_id', { simple: true }) as number;

/**
 * Appends one event, chained onto the last. Runs in its own
 * (nested, if the caller already has one) transaction: the id is read
 * and the row written with no other writer in between, because the id
 * is part of what is hashed. Callers write it inside the transaction
 * of the change it describes (spec decision 1).
 */
export function appendAuditEvent<A extends AuditAction>(
  db: Database.Database,
  event: NewAuditEvent<A>,
): AuditEventRow {
  return db.transaction((): AuditEventRow => {
    const last = db
      .prepare('SELECT id, chain_hash FROM audit_event ORDER BY id DESC LIMIT 1')
      .get() as { id: number; chain_hash: string } | undefined;
    const fields = {
      id: (last?.id ?? 0) + 1,
      at: new Date().toISOString(),
      actor: formatActor(event.actor.actor),
      action: event.action,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      batchId: event.batchId ?? null,
      // Hashed as the exact string stored (spec §3.1).
      detail: event.detail === null ? null : JSON.stringify(event.detail),
    };
    const row: AuditEventRow = {
      ...fields,
      actorLabel: event.actor.label,
      chainHash: chainHash(last?.chain_hash ?? genesisHash(applicationId(db)), fields),
    };
    db.prepare(
      `INSERT INTO audit_event
         (id, at, actor, actor_label, action, subject_type, subject_id, batch_id,
          detail, chain_hash)
       VALUES
         (@id, @at, @actor, @actorLabel, @action, @subjectType, @subjectId, @batchId,
          @detail, @chainHash)`,
    ).run(row);
    return row;
  })();
}

export interface ListEventsParams {
  readonly subjectType: string;
  /** Omit to list every event about this type of subject. */
  readonly subjectId?: string | null;
}

/** One subject's history, oldest first. */
export function listEvents(
  db: Database.Database,
  params: ListEventsParams,
): AuditEventRow[] {
  const rows =
    params.subjectId === undefined
      ? db
          .prepare('SELECT * FROM audit_event WHERE subject_type = ? ORDER BY id')
          .all(params.subjectType)
      : db
          .prepare(
            `SELECT * FROM audit_event
             WHERE subject_type = ? AND subject_id IS ? ORDER BY id`,
          )
          .all(params.subjectType, params.subjectId);
  return (rows as EventRow[]).map(fromRow);
}

/** Everything a batch touched (spec §2.3): its children, oldest first. */
export function listBatch(db: Database.Database, batchId: number): AuditEventRow[] {
  const rows = db
    .prepare('SELECT * FROM audit_event WHERE batch_id = ? ORDER BY id')
    .all(batchId) as EventRow[];
  return rows.map(fromRow);
}

export interface AuditVerification {
  /** How many events were checked. */
  readonly events: number;
  /** The first event that breaks the chain, or `null` if it is intact. */
  readonly brokenAt: number | null;
}

/**
 * Recomputes the whole chain (spec §3). Proves nothing was edited,
 * removed or inserted between two rows; rows removed from the end are
 * invisible to it (§3.1).
 */
export function verifyAudit(db: Database.Database): AuditVerification {
  // Both read before the iterator opens: it holds the connection busy.
  const appId = applicationId(db);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM audit_event').get() as {
    n: number;
  };
  const rows = db
    .prepare('SELECT * FROM audit_event ORDER BY id')
    .iterate() as IterableIterator<EventRow>;
  function* mapped(): Generator<AuditEventRow> {
    for (const row of rows) yield fromRow(row);
  }
  return { events: n, brokenAt: verifyAuditChain(mapped(), appId) };
}
