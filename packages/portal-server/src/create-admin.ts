/**
 * One-off admin account creation (portal-v0-spec.md §7). Not an HTTP
 * endpoint — self-service admin signup isn't a v0 need with one admin —
 * run this once per deployment:
 *
 *   pnpm --filter @cat-tool/portal-server run create-admin -- [--tenant <id>] <email> <password>
 *
 * With a tenant registry (`PORTAL_TENANTS_FILE`, backlog #208) the admin belongs to one tenant's
 * portal, so `--tenant` names it: a tenant's admin is created per file.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createAdminUser, openPortalDb } from '@cat-tool/db';
import { hashPassword } from '@cat-tool/portal-core';

import { tenantCommand } from './tenant-cli.js';

const { tenant, args } = tenantCommand(process.argv.slice(2));
const [email, password] = args;
if (!email || !password) {
  console.error('usage: create-admin [--tenant <id>] <email> <password>');
  process.exit(1);
}

mkdirSync(dirname(tenant.dbPath), { recursive: true });
const db = openPortalDb(tenant.dbPath);

const admin = createAdminUser(db, email, hashPassword(password));
console.log(`Created admin user #${admin.id} <${admin.email}>`);

db.close();
