/**
 * A tenant's single sign-on policy (issue #317, `planning/sso-spec.md` D7, §2a): whether its staff
 * must sign in with a provider, and which Microsoft directory or Google Workspace domain each
 * provider is locked to. Absence-based: a tenant with no row has no policy.
 *
 * Three rules, each here and nowhere else, so a route cannot apply one and forget another:
 *
 * - **Staff only.** A vendor belongs to no tenant (`tenantOfAccount` is `null`) and no policy
 *   reaches them.
 * - **Nobody is shut out.** A password sign-in is refused only to staff who hold a link that meets
 *   the locks ({@link staffPasswordRefused}), and requiring SSO is refused unless the acting admin
 *   holds such a link ({@link setSsoPolicy}).
 * - **A lock is checked on every staff sign-in by a provider** ({@link staffIdentityAllowed}).
 */

import {
  identityMeetsLock,
  type AuditActor,
  type SsoLock,
  type SsoProvider,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { tenantOfAccount } from './accounts.js';
import { appendPlatformEvent } from './audit-write.js';

/** A tenant's policy as stored. */
export interface SsoPolicy extends SsoLock {
  readonly requireSso: boolean;
  readonly updatedAt: string;
  readonly updatedBy: number;
}

/** What an admin sets. */
export interface SsoPolicyInput extends SsoLock {
  readonly requireSso: boolean;
}

/** Requiring SSO would leave the acting admin with no way in: they hold no link that meets the locks. */
export class SsoLockoutError extends Error {
  constructor() {
    super(
      'link a Microsoft or Google account that meets these settings to your own account first, ' +
        'or you would be locked out',
    );
    this.name = 'SsoLockoutError';
  }
}

interface PolicyRow {
  require_sso: number;
  microsoft_tid: string | null;
  google_hd: string | null;
  updated_at: string;
  updated_by: number;
}

/** A tenant's policy, or `null` when it has none. */
export function getSsoPolicy(db: Database.Database, tenantId: number): SsoPolicy | null {
  const row = db
    .prepare(
      `SELECT require_sso, microsoft_tid, google_hd, updated_at, updated_by
       FROM tenant_sso_policy WHERE tenant_id = ?`,
    )
    .get(tenantId) as PolicyRow | undefined;
  return row
    ? {
        requireSso: row.require_sso === 1,
        microsoftTid: row.microsoft_tid,
        googleHd: row.google_hd,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      }
    : null;
}

/** Whether an account holds a link that the locks would let in. */
function holdsQualifyingLink(
  db: Database.Database,
  accountId: number,
  lock: SsoLock,
): boolean {
  const links = db
    .prepare(
      'SELECT provider, issuer, hosted_domain FROM account_identity WHERE account_id = ?',
    )
    .all(accountId) as Array<{
    provider: SsoProvider;
    issuer: string;
    hosted_domain: string | null;
  }>;
  return links.some((l) =>
    identityMeetsLock(
      { provider: l.provider, issuer: l.issuer, hostedDomain: l.hosted_domain },
      lock,
    ),
  );
}

/**
 * Sets a tenant's policy and records `tenant.sso_policy_set`, in one transaction. Setting the
 * values it already holds changes and logs nothing. Requiring SSO is refused unless the acting
 * admin holds a link that meets the locks being set; clearing it, or setting locks alone, never is.
 *
 * @param input - The policy. A directory id is a GUID; a domain a host name, stored lower case.
 * @param options.accountId - The acting admin, whose own links are checked.
 * @throws {SsoLockoutError} if requiring SSO would lock the acting admin out.
 * @throws RangeError for a directory id that is not a GUID, or a domain that is not a host name.
 */
export function setSsoPolicy(
  db: Database.Database,
  tenantId: number,
  input: SsoPolicyInput,
  options: {
    readonly actor: AuditActor;
    readonly accountId: number;
    readonly now?: Date;
  },
): SsoPolicy {
  const microsoftTid =
    input.microsoftTid === null ? null : input.microsoftTid.toLowerCase();
  const googleHd = input.googleHd === null ? null : input.googleHd.toLowerCase();
  if (
    microsoftTid !== null &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(microsoftTid)
  ) {
    throw new RangeError('a Microsoft directory id is a GUID');
  }
  if (
    googleHd !== null &&
    (googleHd.length > 253 ||
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(googleHd))
  ) {
    throw new RangeError('a Google Workspace domain is a host name, such as example.org');
  }
  return db
    .transaction((): SsoPolicy => {
      const held = getSsoPolicy(db, tenantId);
      if (
        held &&
        held.requireSso === input.requireSso &&
        held.microsoftTid === microsoftTid &&
        held.googleHd === googleHd
      ) {
        return held;
      }
      if (
        input.requireSso &&
        !holdsQualifyingLink(db, options.accountId, { microsoftTid, googleHd })
      ) {
        throw new SsoLockoutError();
      }
      const now = (options.now ?? new Date()).toISOString();
      db.prepare(
        `INSERT INTO tenant_sso_policy (tenant_id, require_sso, microsoft_tid, google_hd, updated_at, updated_by)
         VALUES (@tenant, @require, @tid, @hd, @now, @by)
         ON CONFLICT (tenant_id) DO UPDATE SET
           require_sso = excluded.require_sso, microsoft_tid = excluded.microsoft_tid,
           google_hd = excluded.google_hd, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      ).run({
        tenant: tenantId,
        require: input.requireSso ? 1 : 0,
        tid: microsoftTid,
        hd: googleHd,
        now,
        by: options.accountId,
      });
      appendPlatformEvent(db, {
        actor: options.actor,
        action: 'tenant.sso_policy_set',
        tenantId,
        subjectType: 'tenant',
        subjectId: String(tenantId),
        detail: {
          require_sso: input.requireSso,
          microsoft_tid: microsoftTid,
          google_hd: googleHd,
        },
      });
      return getSsoPolicy(db, tenantId)!;
    })
    .immediate();
}

const lockOf = (policy: SsoPolicy): SsoLock => ({
  microsoftTid: policy.microsoftTid,
  googleHd: policy.googleHd,
});

/**
 * Whether a password sign-in must be refused for this account: it is staff of a tenant that requires
 * SSO, and it holds a link that would let it in. Never for a vendor, and never for staff whose links
 * all fall outside the locks (they keep their password, so the policy shuts nobody out).
 */
export function staffPasswordRefused(db: Database.Database, accountId: number): boolean {
  const tenantId = tenantOfAccount(db, accountId);
  if (tenantId === null) return false;
  const policy = getSsoPolicy(db, tenantId);
  if (!policy?.requireSso) return false;
  return holdsQualifyingLink(db, accountId, lockOf(policy));
}

/**
 * Whether a sign-in by this identity may open this account: always for a vendor and for staff of a
 * tenant with no locks; otherwise only an identity that meets the tenant's lock for its provider.
 */
export function staffIdentityAllowed(
  db: Database.Database,
  accountId: number,
  identity: {
    readonly provider: SsoProvider;
    readonly issuer: string;
    readonly hostedDomain: string | null;
  },
): boolean {
  const tenantId = tenantOfAccount(db, accountId);
  return tenantId === null || tenantIdentityAllowed(db, tenantId, identity);
}

/**
 * Whether a tenant's locks let this identity in. Asked before a staff invitation is accepted by a
 * provider, so nobody is given an account whose only way in the policy would then refuse.
 */
export function tenantIdentityAllowed(
  db: Database.Database,
  tenantId: number,
  identity: {
    readonly provider: SsoProvider;
    readonly issuer: string;
    readonly hostedDomain: string | null;
  },
): boolean {
  const policy = getSsoPolicy(db, tenantId);
  return policy === null || identityMeetsLock(identity, lockOf(policy));
}
