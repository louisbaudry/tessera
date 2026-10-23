/**
 * Sets a tenant's display name (`planning/tenant-spec.md` D12, backlog #204): how the
 * first tenant, which the migration left named `Tenant <id>`, gets its real name
 * without the name ever entering this public repo. Run by the operator:
 *
 *   pnpm --filter @cat-tool/server run rename-tenant -- <tenant-id> <name>
 *
 * Logs `tenant.renamed` naming whoever ran it (`cli:<OS user>`); neither name is in
 * the event. Naming the same name again changes and logs nothing.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { openPlatformDb, osUserActor, renameTenant, TenantError } from '@cat-tool/db';

import { loadConfig } from './config.js';

// Strip pnpm's forwarded `--`, as create-account does.
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const [rawId, name] = args;
const tenantId = Number(rawId);
if (!name || !Number.isSafeInteger(tenantId) || tenantId < 1) {
  console.error('usage: rename-tenant <tenant-id> <name>');
  process.exit(1);
}

const actor = osUserActor();
const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openPlatformDb(config.dbPath);
try {
  const tenant = renameTenant(db, { tenantId, name, actor });
  console.log(`Tenant #${tenant.id} renamed`);
} catch (error) {
  if (error instanceof TenantError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
} finally {
  db.close();
}
