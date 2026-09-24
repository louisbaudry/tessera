/**
 * What every command shares: the I/O seam, the one error type that
 * means "tell the user and exit 1", argument parsing, and opening a
 * project that must already exist.
 */

import { existsSync } from 'node:fs';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import type { AuditActor, Project } from '@cat-tool/core';
import { getProject, openProjectDb, osUserActor, OsUserError } from '@cat-tool/db';

/** Output goes through this rather than `console` so tests can capture it. */
export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** A user-facing failure: its message is printed as is, exit status 1. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export type ProjectDb = ReturnType<typeof openProjectDb>;

type Options = NonNullable<ParseArgsConfig['options']>;

/**
 * `node:util`'s `parseArgs`, strict, with positionals allowed and its
 * own errors (unknown option, missing value) turned into a `CliError`
 * so they print like every other usage mistake.
 */
export function parse<const O extends Options>(args: readonly string[], options: O) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
}

export function positional(
  positionals: readonly string[],
  index: number,
  what: string,
  usage: string,
): string {
  const value = positionals[index];
  if (value === undefined) {
    throw new CliError(`missing ${what}\nusage: ${usage}`);
  }
  return value;
}

/** An optional numeric option, refused unless a non-negative integer. */
export function integer(value: string | undefined, what: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new CliError(`${what} must be a non-negative integer, got "${value}"`);
  }
  return n;
}

/**
 * Opens a project that `init` already created. `openProjectDb` would
 * happily create an empty database at a mistyped path; every command
 * but `init` wants a project that exists and has its identity row.
 */
export function openExistingProject(path: string): { db: ProjectDb; project: Project } {
  if (!existsSync(path)) {
    throw new CliError(`no project at ${path} — run "cat-tool init" first`);
  }
  const db = openProjectDb(path);
  const project = getProject(db);
  if (!project) {
    db.close();
    throw new CliError(`${path} is not an initialised project (no identity row)`);
  }
  return { db, project };
}

/** `cli:<OS user>` (audit-spec.md §2.1), or a user-facing refusal. */
export function cliActor(): AuditActor {
  try {
    return osUserActor();
  } catch (err) {
    if (err instanceof OsUserError) throw new CliError(err.message);
    throw err;
  }
}
