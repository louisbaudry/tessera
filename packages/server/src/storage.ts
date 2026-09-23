/**
 * Where an account's files live (v1-spec.md §4.1a, §2.5).
 *
 * Every path the server ever touches is built here, from two things it
 * generated itself — the account's `storage_root` (`u/<hex>`, minted by
 * `createAccount`) and a project name this module validates — so a
 * request can never name a path. That is what "storage root resolved
 * per authenticated session before any file path is touched" means in
 * code: there is no function that takes a path from the outside.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Account } from '@cat-tool/db';

export class InvalidProjectNameError extends Error {
  constructor(name: string) {
    super(
      `invalid project name "${name}": use 1–64 lowercase letters, digits and hyphens, ` +
        'starting and ending with a letter or digit',
    );
    this.name = 'InvalidProjectNameError';
  }
}

/**
 * A project is addressed by a slug, which is also its file's basename.
 * The alphabet is the whole defence against path traversal: nothing
 * matching this can contain a separator, a dot, or be empty.
 */
const PROJECT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isProjectName(name: string): boolean {
  return PROJECT_NAME.test(name);
}

const PROJECT_EXT = '.catdb';

/** The directory an account's projects live in, under the server's volume. */
export function projectsDir(storageRoot: string, account: Account): string {
  return join(storageRoot, account.storageRoot, 'projects');
}

/** The `.catdb` path for a project name, after validating the name. */
export function projectPath(storageRoot: string, account: Account, name: string): string {
  if (!isProjectName(name)) throw new InvalidProjectNameError(name);
  return join(projectsDir(storageRoot, account), `${name}${PROJECT_EXT}`);
}

/** Every project name under an account's root, sorted; none before the first is created. */
export function listProjectNames(storageRoot: string, account: Account): string[] {
  const dir = projectsDir(storageRoot, account);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(PROJECT_EXT))
    .map((f) => f.slice(0, -PROJECT_EXT.length))
    .filter(isProjectName)
    .sort();
}
