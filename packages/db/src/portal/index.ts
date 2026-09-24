import type Database from 'better-sqlite3';

import { openAndMigrate } from '../migrate.js';
import { PORTAL_APPLICATION_ID, PORTAL_MIGRATIONS } from './schema.js';

/** Opens the server's `portal.sqlite`, creating and migrating it as needed. */
export function openPortalDb(path: string): Database.Database {
  return openAndMigrate(path, {
    applicationId: PORTAL_APPLICATION_ID,
    migrations: PORTAL_MIGRATIONS,
  });
}

export { PORTAL_APPLICATION_ID, PORTAL_MIGRATIONS } from './schema.js';
export * from './admin.js';
export * from './clients.js';
export * from './rates.js';
export * from './orders.js';
export * from './files.js';
export * from './audit.js';
