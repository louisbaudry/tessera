/**
 * Sets a tenant's slug, the label its address is built from (`planning/tenant-spec.md` D14,
 * backlog #209): the operator names it, so a company's name never enters this public repo.
 * Run by the operator:
 *
 *   pnpm --filter @cat-tool/server run set-tenant-slug -- <tenant-id> <slug>
 *
 * A slug is set once: it is in every link already sent, so a second, different one is
 * refused. Logs `tenant.slug_set` naming whoever ran it (`cli:<OS user>`); the slug is not
 * in the event. Setting the same slug again changes and logs nothing.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { openPlatformDb, osUserActor, setTenantSlug, TenantError } from '@cat-tool/db';

import { loadConfig } from './config.js';

// Strip pnpm's forwarded `--`, as create-account does.
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const [rawId, slug] = args;
const tenantId = Number(rawId);
if (!slug || !Number.isSafeInteger(tenantId) || tenantId < 1) {
  console.error('usage: set-tenant-slug <tenant-id> <slug>');
  process.exit(1);
}

const actor = osUserActor();
const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openPlatformDb(config.dbPath);
try {
  const tenant = setTenantSlug(db, { tenantId, slug, actor });
  console.log(`Tenant #${tenant.id} has a slug`);
} catch (error) {
  if (error instanceof TenantError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
} finally {
  db.close();
}
