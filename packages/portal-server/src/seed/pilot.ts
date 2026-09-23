/**
 * Seed/demo data for a pilot client (portal-v0-spec.md). Idempotent-ish — safe to re-run against a fresh db, will
 * throw on a second run against the same db (unique email/access token),
 * which is the intended guard against accidentally reseeding production.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createClient, openPortalDb, setRate } from '@cat-tool/db';

import { loadConfig } from '../config.js';

const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openPortalDb(config.dbPath);

// The access token is the client's whole credential (portal-v0-spec.md
// §7), so it is minted per seed, never written into source.
const client = createClient(
  db,
  'Pilot Client',
  'pilot@client.example',
  randomBytes(24).toString('base64url'),
);

// Example rates only; set real ones with `POST /api/admin/rates`.
setRate(db, { srcLang: 'en', tgtLang: 'es', ratePerWord: 0.1, minimumPrice: 40 });
setRate(db, { srcLang: 'en', tgtLang: 'fr', ratePerWord: 0.1, minimumPrice: 40 });
setRate(db, { srcLang: 'en', tgtLang: 'it', ratePerWord: 0.1, minimumPrice: 40 });
setRate(db, { srcLang: 'es', tgtLang: 'en', ratePerWord: 0.1, minimumPrice: 40 });

console.log(`Seeded client "${client.name}" <${client.email}>`);
console.log(`Client portal link: /client.html#token=${client.accessToken}`);
console.log('Seeded rates: en->es, en->fr, en->it, es->en');
console.log(
  'No admin account seeded here — run ' +
    '`pnpm --filter @cat-tool/portal-server run create-admin -- <email> <password>` ' +
    'once, with a real password, rather than committing one to this script.',
);

db.close();
