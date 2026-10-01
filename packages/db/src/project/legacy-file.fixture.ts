/**
 * A file inserted the way a project before v10 stored one (backlog #34):
 * the columns `segment` had then, and its `file.added` event. For tests
 * that open an older schema, write to it, then migrate — today's
 * `insertFile` writes columns that file does not have yet. A historical
 * snapshot, like a migration's DDL: it never follows `insertFile`.
 */
import { createHash } from 'node:crypto';

import type { AssembledFile, AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';

export function insertFileBeforeV10(
  db: Database.Database,
  relPath: string,
  assembled: AssembledFile,
  actor: AuditActor,
): number {
  return db.transaction((): number => {
    const fileId = db
      .prepare(
        `INSERT INTO file (rel_path, original_blob, skeleton, part_map, imported_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        relPath,
        Buffer.from(assembled.originalBlob),
        JSON.stringify(assembled.skeleton),
        JSON.stringify(assembled.partMap),
        new Date().toISOString(),
      ).lastInsertRowid as number;
    const insert = db.prepare(
      `INSERT INTO segment (file_id, part, ord, para_key, para_ord, source_tokens,
         format_table, source_hash, status, locked, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of assembled.segments) {
      insert.run(
        fileId,
        s.part,
        s.ord,
        s.paraKey,
        s.paraOrd,
        JSON.stringify(s.sourceTokens),
        JSON.stringify(s.formatTable),
        s.sourceHash,
        s.status,
        s.locked ? 1 : 0,
        new Date().toISOString(),
      );
    }
    appendAuditEvent(db, {
      actor,
      action: 'file.added',
      subjectType: 'file',
      subjectId: String(fileId),
      detail: {
        rel_path: relPath,
        sha256: createHash('sha256').update(assembled.originalBlob).digest('hex'),
      },
    });
    return fileId;
  })();
}
