/**
 * Provisions a tenant: a customer LSP and its first admin, in one write
 * (`planning/tenant-spec.md` D7, backlog #204). There is no signup route; the
 * operator runs this once per customer:
 *
 *   pnpm --filter @cat-tool/server run create-tenant -- <name> <admin-email> <admin-password>
 *
 * The name is the company's own, typed here and never committed (D12: this repo is
 * public). Quote it if it has spaces. The command prints ids, not the name back, and
 * its `tenant.created` event carries neither the name nor the email.
 *
 * Its events name whoever ran it, `cli:<OS user>`, the same self-asserted actor as
 * `create-account` (audit-spec.md §2.1, §2.5).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { hashPassword } from '@cat-tool/core';
import { createTenant, openPlatformDb, osUserActor, TenantError } from '@cat-tool/db';

import { loadConfig } from './config.js';

// pnpm forwards the `--` that separates its own flags from the script's arguments
// (create-account's first smoke run made an account whose email was `--`).
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const [name, email, password] = args;
if (!name || !email || !password || !email.includes('@')) {
  console.error('usage: create-tenant <name> <admin-email> <admin-password>');
  process.exit(1);
}

// Resolved before anything is written: no user name, no tenant.
const actor = osUserActor();
const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openPlatformDb(config.dbPath);
try {
  const { tenant, account } = createTenant(db, {
    name,
    email,
    passwordHash: hashPassword(password),
    actor,
  });
  console.log(
    `Created tenant #${tenant.id}, with admin account #${account.id}, storage root ${tenant.storageRoot}`,
  );
} catch (error) {
  if (error instanceof TenantError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
} finally {
  db.close();
}
