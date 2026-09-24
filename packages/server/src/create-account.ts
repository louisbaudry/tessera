/**
 * The one account v1 ships with (v1-spec.md §4.1a), created at deploy
 * time by this script rather than a signup endpoint — there is no
 * registration flow yet, and this is still a personal tool reached
 * over the internet. Run once per deployment:
 *
 *   pnpm --filter @cat-tool/server run create-account -- <email> <password>
 *
 * Running it again with another email is how a second account would
 * be added: §4.1a scoped storage by account from the first row so that
 * this is additive, not a migration.
 *
 * Its `account.created` event names whoever ran it, `cli:<OS user>` —
 * the same self-asserted actor as the CLI (audit-spec.md §2.1, §2.5).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { hashPassword } from '@cat-tool/core';
import { createAccount, openPlatformDb, osUserActor } from '@cat-tool/db';

import { loadConfig } from './config.js';

// pnpm forwards the `--` that separates its own flags from the script's
// arguments, so `run create-account -- a@b.c pw` arrives as
// ['--', 'a@b.c', 'pw']. The first smoke run of this script created an
// account whose email was `--`.
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const [email, password] = args;
if (!email || !password || !email.includes('@')) {
  console.error('usage: create-account <email> <password>');
  process.exit(1);
}

// Resolved before anything is written: no user name, no account.
const actor = osUserActor();
const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openPlatformDb(config.dbPath);
try {
  const account = createAccount(db, {
    email,
    passwordHash: hashPassword(password),
    actor,
  });
  console.log(
    `Created account #${account.id} <${account.email}>, storage root ${account.storageRoot}`,
  );
} finally {
  db.close();
}
