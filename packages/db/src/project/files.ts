/**
 * `file` repository (v1-spec.md §4.1; backlog #16).
 *
 * `insertFile` is the one place a `file` row and its `segment` rows are
 * ever written together — an `AssembledFile` (`@cat-tool/core`'s
 * `assembleFile`) arrives as one unit and is persisted as one
 * transaction, so a project database never holds a file with a
 * partial or missing segment set.
 */

import type { AssembledFile, ProjectFile } from '@cat-tool/core';
import type Database from 'better-sqlite3';

interface FileRow {
  id: number;
  rel_path: string;
  original_blob: Buffer;
  skeleton: string;
  part_map: string;
  imported_at: string;
}

const fromRow = (row: FileRow): ProjectFile => ({
  id: row.id,
  relPath: row.rel_path,
  originalBlob: new Uint8Array(row.original_blob),
  skeleton: JSON.parse(row.skeleton) as ProjectFile['skeleton'],
  partMap: JSON.parse(row.part_map) as readonly string[],
  importedAt: row.imported_at,
});

/**
 * Persists an assembled file and every segment it produced, atomically.
 */
export function insertFile(
  db: Database.Database,
  relPath: string,
  assembled: AssembledFile,
): ProjectFile {
  const insertFileStmt = db.prepare(
    `INSERT INTO file (rel_path, original_blob, skeleton, part_map, imported_at)
     VALUES (@rel_path, @original_blob, @skeleton, @part_map, @imported_at)`,
  );
  const insertSegmentStmt = db.prepare(
    `INSERT INTO segment
       (file_id, part, ord, para_key, para_ord, source_tokens, format_table,
        source_hash, status, locked, updated_at)
     VALUES
       (@file_id, @part, @ord, @para_key, @para_ord, @source_tokens, @format_table,
        @source_hash, @status, @locked, @updated_at)`,
  );

  return db.transaction((): ProjectFile => {
    const importedAt = new Date().toISOString();
    const info = insertFileStmt.run({
      rel_path: relPath,
      original_blob: Buffer.from(assembled.originalBlob),
      skeleton: JSON.stringify(assembled.skeleton),
      part_map: JSON.stringify(assembled.partMap),
      imported_at: importedAt,
    });
    const fileId = info.lastInsertRowid as number;

    for (const segment of assembled.segments) {
      insertSegmentStmt.run({
        file_id: fileId,
        part: segment.part,
        ord: segment.ord,
        para_key: segment.paraKey,
        para_ord: segment.paraOrd,
        source_tokens: JSON.stringify(segment.sourceTokens),
        format_table: JSON.stringify(segment.formatTable),
        source_hash: segment.sourceHash,
        status: segment.status,
        locked: segment.locked ? 1 : 0,
        updated_at: importedAt,
      });
    }

    return {
      id: fileId,
      relPath,
      originalBlob: assembled.originalBlob,
      skeleton: assembled.skeleton,
      partMap: assembled.partMap,
      importedAt,
    };
  })();
}

export function getFile(db: Database.Database, id: number): ProjectFile | null {
  const row = db.prepare('SELECT * FROM file WHERE id = ?').get(id) as
    FileRow | undefined;
  return row ? fromRow(row) : null;
}

export function listFiles(db: Database.Database): ProjectFile[] {
  const rows = db.prepare('SELECT * FROM file ORDER BY id').all() as FileRow[];
  return rows.map(fromRow);
}
