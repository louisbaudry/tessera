/**
 * Export a project file to DOCX (v1-spec.md §2.4, §3.4; backlog #25).
 *
 * The orchestration half of `core/project/export.ts`, split the way
 * `pretranslate.ts` is from `core/tm/pretranslate.ts`: load the file
 * and its segments, hand them to the pure fold, return the bytes. What
 * to do with the bytes — write them under `rel_path`, stream them over
 * HTTP — is the caller's.
 */

import { exportProjectFile, type ExportedFile, type ProjectFile } from '@cat-tool/core';
import type Database from 'better-sqlite3';

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

export function exportFile(db: Database.Database, fileId: number): ExportFileResult {
  const file = getFile(db, fileId);
  if (!file) {
    throw new ProjectExportError(`no file with id ${fileId}`);
  }
  const exported = exportProjectFile(file, listSegments(db, fileId));
  return { file, ...exported };
}
