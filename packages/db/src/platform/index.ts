import type Database from 'better-sqlite3';

import { openAndMigrate } from '../migrate.js';
import { PLATFORM_APPLICATION_ID, PLATFORM_MIGRATIONS } from './schema.js';

/** Opens the server's `platform.sqlite`, creating and migrating it as needed. */
export function openPlatformDb(path: string): Database.Database {
  return openAndMigrate(path, {
    applicationId: PLATFORM_APPLICATION_ID,
    migrations: PLATFORM_MIGRATIONS,
  });
}

export { PLATFORM_APPLICATION_ID, PLATFORM_MIGRATIONS } from './schema.js';
export * from './accounts.js';
export * from './audit.js';
