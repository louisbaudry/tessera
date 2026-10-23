/**
 * Opening a tenant's roster file (`.ctv`), the one place the server does it:
 * the assignment routes, the invitations (which put a new vendor on it) and the
 * webhook dispatcher all reach the same file by the same path, never one
 * built from anything a request sent (`storage.ts`).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createVendorFile, openVendorFile, type Tenant } from '@cat-tool/db';

import { vendorsPath } from './storage.js';

/** What the roster file records as the tool that made it. */
const GENERATOR = 'cat-tool/server';

/** An open roster. The caller closes it. */
export type Roster = ReturnType<typeof openVendorFile>;

/** The tenant's roster, or null if it has none yet. */
export function openRoster(storageRoot: string, tenant: Tenant): Roster | null {
  const path = vendorsPath(storageRoot, tenant);
  return existsSync(path) ? openVendorFile(path) : null;
}

/** The tenant's roster, creating the file the first time it is needed. */
export function openOrCreateRoster(storageRoot: string, tenant: Tenant): Roster {
  const path = vendorsPath(storageRoot, tenant);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    return createVendorFile(path, { generator: GENERATOR });
  }
  return openVendorFile(path);
}
