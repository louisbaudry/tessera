/**
 * Reference files of a project (issue #203, `v1-spec.md` §7.9).
 *
 * Kept as rows in the project's own database, so a file travels with the
 * project and can only be looked up in it: the id means nothing in another
 * project's database. Every rule that decides what may be stored is `core`'s
 * (`core/project/reference.ts`); this is the write path around it: validate,
 * insert and audit in one transaction, with the actor required. A listing
 * never reads `data`.
 */

import { createHash } from 'node:crypto';

import {
  REFERENCE_MAX_BYTES,
  REFERENCE_MAX_FILES,
  referenceDisplayName,
  referenceLabel,
  sniffReferenceType,
  type AuditActor,
  type ReferenceMediaType,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';

/** What a reference file is, without its bytes. */
export interface ReferenceFile {
  readonly id: number;
  /** Its stored name: the owner's to see, never a translator's. */
  readonly name: string;
  /** What the owner chose to call it for the people working on the project. */
  readonly label: string | null;
  readonly mediaType: ReferenceMediaType;
  readonly size: number;
  readonly sha256: string;
  readonly addedAt: string;
}

export type ReferenceFileErrorReason =
  'empty' | 'too_big' | 'type' | 'too_many' | 'label';

/** Why a file was not added; `reason` is stable, the message says it in words. */
export class ReferenceFileError extends Error {
  constructor(
    readonly reason: ReferenceFileErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'ReferenceFileError';
  }
}

interface Row {
  id: number;
  name: string;
  label: string | null;
  media_type: string;
  size: number;
  sha256: string;
  added_at: string;
}

const COLUMNS = 'id, name, label, media_type, size, sha256, added_at';

const fromRow = (row: Row): ReferenceFile => ({
  id: row.id,
  name: row.name,
  label: row.label,
  mediaType: row.media_type as ReferenceMediaType,
  size: row.size,
  sha256: row.sha256,
  addedAt: row.added_at,
});

export interface AddReferenceFileOptions {
  /** The name it was uploaded under; only its last segment is kept. */
  readonly name: string;
  readonly label?: string | null;
  readonly bytes: Uint8Array;
  /** Who attached it — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

/**
 * Attaches a file. Its type is read from its bytes and must be one of
 * `REFERENCE_MEDIA_TYPES`; it must be non-empty and at most
 * `REFERENCE_MAX_BYTES`, and the project holds at most `REFERENCE_MAX_FILES`.
 * Logs `reference.added` in the same transaction, with the size and digest and
 * never the name or label.
 *
 * @throws ReferenceFileError for a file or label that is refused.
 */
export function addReferenceFile(
  db: Database.Database,
  options: AddReferenceFileOptions,
): ReferenceFile {
  const { bytes } = options;
  if (bytes.length === 0) {
    throw new ReferenceFileError('empty', 'the file is empty');
  }
  if (bytes.length > REFERENCE_MAX_BYTES) {
    throw new ReferenceFileError(
      'too_big',
      `a reference file is at most ${REFERENCE_MAX_BYTES / (1024 * 1024)} MB`,
    );
  }
  const mediaType = sniffReferenceType(bytes);
  if (!mediaType) {
    throw new ReferenceFileError(
      'type',
      'a reference file is a PDF, PNG, JPEG, GIF or WebP',
    );
  }
  let label: string | null;
  try {
    label = referenceLabel(options.label);
  } catch (err) {
    throw new ReferenceFileError(
      'label',
      err instanceof Error ? err.message : String(err),
    );
  }

  return db.transaction((): ReferenceFile => {
    const held = (
      db.prepare('SELECT COUNT(*) AS n FROM reference_file').get() as { n: number }
    ).n;
    if (held >= REFERENCE_MAX_FILES) {
      throw new ReferenceFileError(
        'too_many',
        `a project holds at most ${REFERENCE_MAX_FILES} reference files`,
      );
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const addedAt = new Date().toISOString();
    const name = referenceDisplayName(options.name);
    const info = db
      .prepare(
        `INSERT INTO reference_file (name, label, media_type, size, sha256, data, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(name, label, mediaType, bytes.length, sha256, Buffer.from(bytes), addedAt);
    const id = Number(info.lastInsertRowid);
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'reference.added',
      subjectType: 'reference_file',
      subjectId: String(id),
      detail: { media_type: mediaType, size: bytes.length, sha256 },
    });
    return { id, name, label, mediaType, size: bytes.length, sha256, addedAt };
  })();
}

/** Every reference file, oldest first, without its bytes. */
export function listReferenceFiles(db: Database.Database): ReferenceFile[] {
  return (
    db.prepare(`SELECT ${COLUMNS} FROM reference_file ORDER BY id`).all() as Row[]
  ).map(fromRow);
}

/** One reference file and its bytes, or null: the id is this project's own. */
export function getReferenceFile(
  db: Database.Database,
  id: number,
): { file: ReferenceFile; data: Uint8Array } | null {
  const row = db
    .prepare(`SELECT ${COLUMNS}, data FROM reference_file WHERE id = ?`)
    .get(id) as (Row & { data: Buffer }) | undefined;
  return row ? { file: fromRow(row), data: new Uint8Array(row.data) } : null;
}

/**
 * Removes a reference file and logs `reference.removed` (size and digest) in the
 * same transaction. Returns false when there is no such file.
 */
export function removeReferenceFile(
  db: Database.Database,
  id: number,
  options: { readonly actor: AuditActor },
): boolean {
  return db.transaction((): boolean => {
    const row = db
      .prepare(`SELECT ${COLUMNS} FROM reference_file WHERE id = ?`)
      .get(id) as Row | undefined;
    if (!row) return false;
    db.prepare('DELETE FROM reference_file WHERE id = ?').run(id);
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'reference.removed',
      subjectType: 'reference_file',
      subjectId: String(id),
      detail: { size: row.size, sha256: row.sha256 },
    });
    return true;
  })();
}
