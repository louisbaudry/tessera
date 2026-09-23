/**
 * `project` repository (v1-spec.md §4.1; backlog #16).
 *
 * A singleton row (`CHECK (id = 1)`), so there is nothing to list or
 * delete — only create once and read.
 */

import type { Project } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { PROJECT_MIGRATIONS } from './schema.js';

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}

export interface CreateProjectOptions {
  readonly name: string;
  readonly srcLang: string;
  readonly tgtLang: string;
}

interface ProjectRow {
  name: string;
  src_lang: string;
  tgt_lang: string;
  created_at: string;
  schema_version: number;
}

const fromRow = (row: ProjectRow): Project => ({
  name: row.name,
  srcLang: row.src_lang,
  tgtLang: row.tgt_lang,
  createdAt: row.created_at,
  schemaVersion: row.schema_version,
});

/**
 * Writes the project's one identity row. Refuses on a database that
 * already has one, the same discipline `createTm` uses for `.ctm` and
 * for the same reason: silently ignoring the options on a second call
 * would be a worse failure than refusing outright.
 */
export function createProject(
  db: Database.Database,
  options: CreateProjectOptions,
): Project {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM project').get() as { n: number };
  if (existing.n > 0) {
    throw new ProjectError('this project database already has an identity row');
  }
  const row: ProjectRow = {
    name: options.name,
    src_lang: options.srcLang,
    tgt_lang: options.tgtLang,
    created_at: new Date().toISOString(),
    // The format version this build writes, not a literal: a project
    // created today is at the latest migration, and stamping "1" forever
    // would misreport every file made after the first schema change.
    schema_version: PROJECT_MIGRATIONS[PROJECT_MIGRATIONS.length - 1]!.version,
  };
  db.prepare(
    `INSERT INTO project (id, name, src_lang, tgt_lang, created_at, schema_version)
     VALUES (1, @name, @src_lang, @tgt_lang, @created_at, @schema_version)`,
  ).run(row);
  return fromRow(row);
}

export function getProject(db: Database.Database): Project | null {
  const row = db.prepare('SELECT * FROM project WHERE id = 1').get() as
    ProjectRow | undefined;
  return row ? fromRow(row) : null;
}
