/**
 * `source_file`/`delivered_file` repositories (portal-v0-spec.md §6).
 *
 * Metadata only — the bytes themselves live on disk under a storage
 * root, `storage_path` here is relative to that root. See
 * `packages/portal-server/src/storage.ts` for where files are written.
 */

import type { AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';

export interface StoredFile {
  readonly id: number;
  readonly orderId: number;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly storagePath: string;
  readonly uploadedAt: string;
}

/**
 * An upload. Its `wordCount` is advisory (§4): what the counter made of
 * it at submit, `null` when it could not or was not asked. The price
 * never reads it; the admin's confirmed total on the order does.
 */
export interface SourceFile extends StoredFile {
  readonly wordCount: number | null;
}

interface FileRow {
  id: number;
  order_id: number;
  filename: string;
  content_type: string;
  byte_size: number;
  storage_path: string;
  uploaded_at: string;
}

interface SourceFileRow extends FileRow {
  word_count: number | null;
}

const fromRow = (row: FileRow): StoredFile => ({
  id: row.id,
  orderId: row.order_id,
  filename: row.filename,
  contentType: row.content_type,
  byteSize: row.byte_size,
  storagePath: row.storage_path,
  uploadedAt: row.uploaded_at,
});

const fromSourceRow = (row: SourceFileRow): SourceFile => ({
  ...fromRow(row),
  wordCount: row.word_count,
});

export interface NewFile {
  readonly orderId: number;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly storagePath: string;
}

export interface NewSourceFile extends NewFile {
  /** The counter's advisory figure, or `null`; never a price input. Required so a caller says which. */
  readonly wordCount: number | null;
}

function insertInto(table: 'source_file' | 'delivered_file') {
  return (db: Database.Database, file: NewFile): StoredFile => {
    const uploadedAt = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO ${table} (order_id, filename, content_type, byte_size, storage_path, uploaded_at)
         VALUES (@order_id, @filename, @content_type, @byte_size, @storage_path, @uploaded_at)`,
      )
      .run({
        order_id: file.orderId,
        filename: file.filename,
        content_type: file.contentType,
        byte_size: file.byteSize,
        storage_path: file.storagePath,
        uploaded_at: uploadedAt,
      });
    return {
      id: info.lastInsertRowid as number,
      orderId: file.orderId,
      filename: file.filename,
      contentType: file.contentType,
      byteSize: file.byteSize,
      storagePath: file.storagePath,
      uploadedAt,
    };
  };
}

function listFor(table: 'source_file' | 'delivered_file') {
  return (db: Database.Database, orderId: number): StoredFile[] => {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE order_id = ? ORDER BY id`)
      .all(orderId) as FileRow[];
    return rows.map(fromRow);
  };
}

function getFrom(table: 'source_file' | 'delivered_file') {
  // Scoped to the order, not looked up by id alone: a route that has
  // already checked the caller may see `orderId` can hand both ids here
  // and get back only a file that really belongs to that order.
  return (db: Database.Database, orderId: number, fileId: number): StoredFile | null => {
    const row = db
      .prepare(`SELECT * FROM ${table} WHERE id = ? AND order_id = ?`)
      .get(fileId, orderId) as FileRow | undefined;
    return row ? fromRow(row) : null;
  };
}

/** Stores an upload's row, with its advisory word count if it has one. */
export function insertSourceFile(db: Database.Database, file: NewSourceFile): SourceFile {
  const uploadedAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO source_file
         (order_id, filename, content_type, byte_size, storage_path, uploaded_at, word_count)
       VALUES
         (@order_id, @filename, @content_type, @byte_size, @storage_path, @uploaded_at, @word_count)`,
    )
    .run({
      order_id: file.orderId,
      filename: file.filename,
      content_type: file.contentType,
      byte_size: file.byteSize,
      storage_path: file.storagePath,
      uploaded_at: uploadedAt,
      word_count: file.wordCount,
    });
  return {
    id: info.lastInsertRowid as number,
    orderId: file.orderId,
    filename: file.filename,
    contentType: file.contentType,
    byteSize: file.byteSize,
    storagePath: file.storagePath,
    uploadedAt,
    wordCount: file.wordCount,
  };
}

export function listSourceFiles(db: Database.Database, orderId: number): SourceFile[] {
  const rows = db
    .prepare('SELECT * FROM source_file WHERE order_id = ? ORDER BY id')
    .all(orderId) as SourceFileRow[];
  return rows.map(fromSourceRow);
}

/** Scoped to the order, like {@link getDeliveredFile}: never by file id alone. */
export function getSourceFile(
  db: Database.Database,
  orderId: number,
  fileId: number,
): SourceFile | null {
  const row = db
    .prepare('SELECT * FROM source_file WHERE id = ? AND order_id = ?')
    .get(fileId, orderId) as SourceFileRow | undefined;
  return row ? fromSourceRow(row) : null;
}

/**
 * The sum of an order's advisory counts, or `null` unless every file has
 * one: a total with a hole in it would be a smaller number passed off as
 * the whole (portal-v0-spec.md §4).
 */
export function sumSourceWordCounts(files: readonly SourceFile[]): number | null {
  if (files.length === 0) return null;
  let total = 0;
  for (const file of files) {
    if (file.wordCount === null) return null;
    total += file.wordCount;
  }
  return total;
}

export interface DeliverFileOptions {
  /** Who delivered it — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
  /** SHA-256 of exactly the bytes stored: what the client was given. */
  readonly sha256: string;
}

const insertDeliveredRow = insertInto('delivered_file');

/**
 * Stores a delivered file's row and records `file.delivered` in the same
 * transaction (audit-spec.md §2.6): "what exactly did we send them, and
 * who" is then a question for the log, not anyone's memory.
 */
export function insertDeliveredFile(
  db: Database.Database,
  file: NewFile,
  options: DeliverFileOptions,
): StoredFile {
  return db.transaction((): StoredFile => {
    const stored = insertDeliveredRow(db, file);
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'file.delivered',
      subjectType: 'delivered_file',
      subjectId: String(stored.id),
      detail: { order_id: stored.orderId, name: stored.filename, sha256: options.sha256 },
    });
    return stored;
  })();
}
export const listDeliveredFiles = listFor('delivered_file');
export const getDeliveredFile = getFrom('delivered_file');
