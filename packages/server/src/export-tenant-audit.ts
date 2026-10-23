/**
 * Writes one tenant's slice of the platform log to a file (backlog #211,
 * `planning/audit-spec.md` §3.1, `tenant-spec.md` §6 invariant 7): what the operator hands
 * a tenant, or keeps, when it leaves. Run by the operator:
 *
 *   pnpm --filter @cat-tool/server run export-tenant-audit -- <tenant-id> <out-file>
 *
 * JSON lines, a header first (`whole_log_intact` says whether the whole log verified when it
 * was cut), then each of the tenant's events as stored. The export is itself logged
 * (`tenant.audit_exported`, a count and a digest, naming `cli:<OS user>`) before the file is
 * written. Refuses to overwrite an existing file.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  exportTenantAudit,
  openPlatformDb,
  osUserActor,
  TenantError,
} from '@cat-tool/db';

import { loadConfig } from './config.js';

// Strip pnpm's forwarded `--`, as create-account does.
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const [rawId, outFile] = args;
const tenantId = Number(rawId);
if (!outFile || !Number.isSafeInteger(tenantId) || tenantId < 1) {
  console.error('usage: export-tenant-audit <tenant-id> <out-file>');
  process.exit(1);
}

// Checked before the export is logged: a refusal must not leave a `tenant.audit_exported`
// for a file that was never written.
if (existsSync(resolve(outFile))) {
  console.error(`${outFile} already exists; it is not overwritten.`);
  process.exit(1);
}

const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openPlatformDb(config.dbPath);
try {
  const out = exportTenantAudit(db, { tenantId, actor: osUserActor() });
  // `wx`: an existing file is never overwritten, so an old export cannot be lost to a new one.
  writeFileSync(resolve(outFile), out.text, { flag: 'wx' });
  console.log(
    `Wrote ${out.events} events of tenant #${tenantId} to ${outFile} (sha256 ${out.sha256})`,
  );
} catch (error) {
  if (error instanceof TenantError) {
    console.error(error.message);
    process.exit(1);
  }
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
    console.error(`${outFile} already exists; it is not overwritten.`);
    process.exit(1);
  }
  throw error;
} finally {
  db.close();
}
