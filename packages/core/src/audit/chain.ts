/**
 * The `audit_event` hash chain (`planning/audit-spec.md` §3, with the
 * byte-level choices in §3.1). Pure: rows in, first broken id out — no
 * database in the loop, so the one definition of the hash is provable
 * from a test and imported by every file that keeps a log.
 *
 * `actor_label` is deliberately not hashed: erasing a person's label
 * (spec §5) is the one permitted change, and it must not look like
 * tampering.
 *
 * `tenantId` is hashed, but only when there is one (spec §3.1, backlog #211): a
 * tenant's slice of the platform log is only trustworthy if moving an event to
 * another tenant is a break, while every row written before the column existed has
 * none and must keep verifying.
 */

import { createHash } from 'node:crypto';

/** An `audit_event` row as stored — `detail` is the JSON string in the column. */
export interface AuditEventRow {
  readonly id: number;
  readonly at: string;
  readonly actor: string;
  readonly actorLabel: string | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly batchId: number | null;
  readonly detail: string | null;
  /**
   * The tenant the event is about: only `platform.sqlite` has the column, and an event
   * that concerns no tenant (the operator's, a refused login) has `null`. Absent and
   * `null` are the same fact, and hash the same.
   */
  readonly tenantId?: number | null;
  readonly chainHash: string;
}

/** The hashed fields: everything but `actorLabel` and the hash itself. */
export type ChainedFields = Omit<AuditEventRow, 'actorLabel' | 'chainHash'>;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The `prev_chain_hash` of a database's first row: its `PRAGMA application_id`, in decimal. */
export function genesisHash(applicationId: number): string {
  return sha256Hex(`CATA:${String(applicationId)}`);
}

/**
 * The fixed-order array that is hashed. `detail` goes in as the stored
 * string, never re-parsed — a re-serialised object could reorder keys.
 * The tenant id is a ninth element **only when set**, so an eight-element row (every
 * row written before the column, and every project, portal and roster event) hashes
 * byte for byte as it always did.
 */
export function canonicalAuditRow(row: ChainedFields): string {
  const fields: Array<string | number | null> = [
    row.id,
    row.at,
    row.actor,
    row.action,
    row.subjectType,
    row.subjectId,
    row.batchId,
    row.detail,
  ];
  if (row.tenantId !== undefined && row.tenantId !== null) fields.push(row.tenantId);
  return JSON.stringify(fields);
}

/** `SHA-256(prev ‖ canonical(row))`, lowercase hex. */
export function chainHash(prevHash: string, row: ChainedFields): string {
  return sha256Hex(prevHash + canonicalAuditRow(row));
}

/**
 * The id of the first row that breaks the chain, or `null` if it is
 * intact. `rows` must be the whole log in ascending `id` order; a row
 * whose id does not exceed the previous one's is itself a break.
 *
 * An edited row is reported as itself; a deleted row as the row after
 * it; an inserted row as itself, or as the row after it if it was
 * hashed correctly. Rows removed from the end are not detectable here:
 * the surviving prefix is a valid chain (spec §3.1).
 */
export function verifyAuditChain(
  rows: Iterable<AuditEventRow>,
  applicationId: number,
): number | null {
  let prev = genesisHash(applicationId);
  let prevId = -Infinity;
  for (const row of rows) {
    if (row.id <= prevId || row.chainHash !== chainHash(prev, row)) return row.id;
    prev = row.chainHash;
    prevId = row.id;
  }
  return null;
}
