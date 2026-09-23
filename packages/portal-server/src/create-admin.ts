/**
 * One-off admin account creation (portal-v0-spec.md §7). Not an HTTP
 * endpoint — self-service admin signup isn't a v0 need with one admin —
 * run this once per deployment:
 *
 *   pnpm --filter @cat-tool/portal-server run create-admin -- <email> <password>
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createAdminUser, openPortalDb } from '@cat-tool/db';
import { hashPassword } from '@cat-tool/portal-core';

import { loadConfig } from './config.js';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('usage: create-admin <email> <password>');
  process.exit(1);
}

const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openPortalDb(config.dbPath);

const admin = createAdminUser(db, email, hashPassword(password));
console.log(`Created admin user #${admin.id} <${admin.email}>`);

db.close();
