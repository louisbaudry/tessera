/**
 * Registers a tenant's portal (backlog #208, `planning/tenant-spec.md` D13): the operator's
 * step, as `create-tenant` is for the CAT server. It writes one entry to the tenant registry
 * (`PORTAL_TENANTS_FILE`) and creates that tenant's own `portal.sqlite` and storage folder.
 *
 *   pnpm --filter @cat-tool/portal-server run add-portal-tenant -- <tenant-id> <host>
 *     [--db <path>] [--storage <path>] [--from <sender>] [--admin-email <address>]
 *     [--display-name <name>]
 *
 * By default the file and folder go beside the registry as `t<id>/portal.sqlite` and
 * `t<id>/storage`. `--db` and `--storage` adopt files that already exist: how the first tenant's
 * existing portal becomes its portal, with no data move. An entry that would share a number, host,
 * file or folder with one already there is refused before anything is created. Then
 * `create-admin -- --tenant <id> <email> <password>` makes that tenant's admin.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { openPortalDb } from '@cat-tool/db';

import { loadConfig } from './config.js';
import {
  addTenant,
  defaultTenantPaths,
  displayName,
  readTenantRegistry,
  serializeTenantRegistry,
  TenantRegistryError,
  type PortalTenant,
} from './tenants.js';

const USAGE =
  'usage: add-portal-tenant <tenant-id> <host> [--db <path>] [--storage <path>] ' +
  '[--from <sender>] [--admin-email <address>] [--display-name <name>]';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg.startsWith('--')) {
    const value = args[++i];
    if (value === undefined) {
      console.error(USAGE);
      process.exit(1);
    }
    flags.set(arg.slice(2), value);
  } else positional.push(arg);
}
const [rawId, host] = positional;
const tenantId = Number(rawId);
const unknown = [...flags.keys()].filter(
  (k) => !['db', 'storage', 'from', 'admin-email', 'display-name'].includes(k),
);
if (!host || !Number.isSafeInteger(tenantId) || tenantId < 1 || unknown.length > 0) {
  console.error(USAGE);
  process.exit(1);
}

const config = loadConfig();
if (config.tenantsFile === undefined) {
  console.error('Set PORTAL_TENANTS_FILE to the registry this tenant is added to.');
  process.exit(1);
}
const registry = config.tenantsFile;

try {
  let existing: PortalTenant[] = [];
  try {
    existing = readTenantRegistry(registry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const defaults = defaultTenantPaths(registry, tenantId);
  const tenant: PortalTenant = {
    tenantId,
    host: host.toLowerCase(),
    dbPath: flags.has('db') ? resolve(flags.get('db')!) : defaults.dbPath,
    storageRoot: flags.has('storage')
      ? resolve(flags.get('storage')!)
      : defaults.storageRoot,
    ...(flags.has('from') ? { from: flags.get('from')! } : {}),
    ...(flags.has('admin-email') ? { adminEmail: flags.get('admin-email')! } : {}),
    ...(flags.has('display-name')
      ? { displayName: displayName(flags.get('display-name')!, '--display-name') }
      : {}),
  };
  const next = addTenant(existing, tenant);

  // Checked first, then created: a refusal leaves nothing behind.
  mkdirSync(dirname(tenant.dbPath), { recursive: true });
  mkdirSync(tenant.storageRoot, { recursive: true });
  openPortalDb(tenant.dbPath).close();
  mkdirSync(dirname(resolve(registry)), { recursive: true });
  const temp = `${registry}.${process.pid}.tmp`;
  writeFileSync(temp, serializeTenantRegistry(next));
  renameSync(temp, registry);
  console.log(`Registered tenant #${tenantId} at ${tenant.host}`);
  console.log(`  database ${tenant.dbPath}`);
  console.log(`  storage  ${tenant.storageRoot}`);
  console.log(
    `Next: pnpm --filter @cat-tool/portal-server run create-admin -- --tenant ${tenantId} <email> <password>`,
  );
} catch (error) {
  if (error instanceof TenantRegistryError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
