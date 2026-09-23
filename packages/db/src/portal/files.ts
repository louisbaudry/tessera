/**
 * `source_file`/`delivered_file` repositories (portal-v0-spec.md §6).
 *
 * Metadata only — the bytes themselves live on disk under a storage
 * root, `storage_path` here is relative to that root. See
 * `packages/portal-server/src/storage.ts` for where files are written.
 */

import type Database from 'better-sqlite3';

export interface StoredFile {
  readonly id: number;
  readonly orderId: number;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly storagePath: string;
  readonly uploadedAt: string;
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

const fromRow = (row: FileRow): StoredFile => ({
  id: row.id,
  orderId: row.order_id,
  filename: row.filename,
  contentType: row.content_type,
  byteSize: row.byte_size,
  storagePath: row.storage_path,
  uploadedAt: row.uploaded_at,
});

export interface NewFile {
  readonly orderId: number;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly storagePath: string;
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

export const insertSourceFile = insertInto('source_file');
export const listSourceFiles = listFor('source_file');
export const getSourceFile = getFrom('source_file');
export const insertDeliveredFile = insertInto('delivered_file');
export const listDeliveredFiles = listFor('delivered_file');
export const getDeliveredFile = getFrom('delivered_file');
