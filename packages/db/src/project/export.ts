/**
 * Export a project file to DOCX (v1-spec.md §2.4, §3.4; backlog #25).
 *
 * The orchestration half of `core/project/export.ts`, split the way
 * `pretranslate.ts` is from `core/tm/pretranslate.ts`: load the file
 * and its segments, hand them to the pure fold, return the bytes. What
 * to do with the bytes — write them under `rel_path`, stream them over
 * HTTP — is the caller's.
 */

import { createHash } from 'node:crypto';

import {
  exportProjectFile,
  type AuditActor,
  type ExportedFile,
  type ProjectFile,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { getFile } from './files.js';
import { listSegments } from './segments.js';

export class ProjectExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectExportError';
  }
}

export interface ExportFileResult extends ExportedFile {
  readonly file: ProjectFile;
}

export interface ExportFileOptions {
  /** Who exported it — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

/**
 * Folds a file back into a DOCX and records a `project.exported` event
 * with the produced bytes' SHA-256 — content leaving the system
 * (audit-spec.md decision 9), recorded at production (§2.4).
 */
export function exportFile(
  db: Database.Database,
  fileId: number,
  options: ExportFileOptions,
): ExportFileResult {
  return db.transaction((): ExportFileResult => {
    const file = getFile(db, fileId);
    if (!file) {
      throw new ProjectExportError(`no file with id ${fileId}`);
    }
    const exported = exportProjectFile(file, listSegments(db, fileId));
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'project.exported',
      subjectType: 'file',
      subjectId: String(fileId),
      detail: { sha256: createHash('sha256').update(exported.bytes).digest('hex') },
    });
    return { file, ...exported };
  })();
}
