/**
 * Test scaffolding: the tenant an account is staff of, read from the platform file of a
 * test's `config`. The server builds every path from a tenant (`planning/tenant-spec.md`
 * D4, backlog #205), and a test that makes accounts with `createAccount` needs the
 * tenant `createAccount` founded for each owner. Like every `*.fixture.ts` it is
 * excluded from the build.
 */

import {
  getTenantForAccount,
  openPlatformDb,
  type Account,
  type Tenant,
} from '@cat-tool/db';

import type { ServerConfig } from './config.js';

/**
 * The tenant `account` is staff of.
 *
 * @throws when the account has none (a vendor): a test that asks has a bug.
 */
export function tenantOf(config: ServerConfig, account: Account): Tenant {
  const platform = openPlatformDb(config.dbPath);
  try {
    const found = getTenantForAccount(platform, account.id);
    if (!found) throw new Error(`account #${account.id} is staff of no tenant`);
    return found.tenant;
  } finally {
    platform.close();
  }
}
