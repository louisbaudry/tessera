import type Database from 'better-sqlite3';

import { openAndMigrate } from '../migrate.js';
import { PROJECT_APPLICATION_ID, PROJECT_MIGRATIONS } from './schema.js';

/** Opens a project's `.catdb`, creating and migrating it as needed. */
export function openProjectDb(path: string): Database.Database {
  return openAndMigrate(path, {
    applicationId: PROJECT_APPLICATION_ID,
    migrations: PROJECT_MIGRATIONS,
  });
}

export { PROJECT_APPLICATION_ID, PROJECT_MIGRATIONS } from './schema.js';
export * from './project.js';
export * from './files.js';
export * from './segments.js';
export * from './tm-refs.js';
export * from './pretranslate.js';
export * from './confirm.js';
export * from './glossary-refs.js';
export * from './qa-settings.js';
export * from './qa-issues.js';
export * from './export.js';
