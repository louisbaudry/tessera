/**
 * Environment-driven config. Conservative defaults so `pnpm --filter
 * @cat-tool/portal-server start` works out of the box for local/dev use;
 * a real deployment overrides every one of these via env vars.
 */
import { resolve } from 'node:path';

import { isCurrencyCode } from '@cat-tool/portal-core';
import { callbackOrigin, ssoProvidersOf, type SsoProviders } from '@cat-tool/sso-http';

/**
 * The currency a portal's prices are in when nothing names one: what every price showed before
 * issue #327, so a portal that sets nothing keeps the symbol its clients already saw.
 */
export const DEFAULT_PORTAL_CURRENCY = 'USD';

/** What one portal's `SmtpNotificationService` is built from: the sender is always known. */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string | undefined;
  readonly pass: string | undefined;
  readonly from: string;
  readonly adminEmail: string;
}

/**
 * The operator's shared SMTP settings. The sender is optional here because a tenant may bring its
 * own (`PortalTenant.from`); `configForTenant` refuses a tenant that ends up with none, so there is
 * no default sender that could name a company (`tenant-spec.md` D12, issue #306).
 */
export type SharedSmtpConfig = Omit<SmtpConfig, 'from'> & { readonly from?: string };

export interface PortalConfig {
  readonly port: number;
  readonly dbPath: string;
  readonly storageRoot: string;
  /**
   * The tenant registry (`tenants.ts`, backlog #208). Absent: the portal is the single one it
   * always was, from `dbPath` and `storageRoot`. Present: those two are ignored, and each
   * registry entry carries its own.
   */
  readonly tenantsFile?: string;
  /** The name the portal pages show; a tenant's own `displayName` wins (issue #310). */
  readonly displayName?: string;
  /**
   * The ISO 4217 code of the portal's prices (issue #327): `PORTAL_CURRENCY`, else
   * `DEFAULT_PORTAL_CURRENCY`; a tenant's own `currency` wins. Recorded in the portal's file at
   * start, and fixed there once an order has a price (`settlePortalCurrency`).
   */
  readonly currency: string;
  /**
   * A client contact's sign-in with Microsoft or Google (issue #342, `sso-spec.md` §2b): the portal's
   * own callback origin (`PORTAL_SSO_CALLBACK_ORIGIN`) and the operator's two provider apps, the same
   * environment variables the CAT server reads. Absent when either is missing: sign-in is then off.
   */
  readonly sso?: { readonly callbackOrigin: string; readonly providers: SsoProviders };
  // Set only when PORTAL_SMTP_HOST is configured — absence is the signal
  // to fall back to ConsoleNotificationService (portal-v0-spec.md §5),
  // same "no real email adapter yet" default v0 shipped with.
  readonly smtp: SharedSmtpConfig | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PortalConfig {
  return {
    port: Number(env.PORTAL_PORT ?? 3300),
    dbPath: resolve(env.PORTAL_DB_PATH ?? './data/portal.sqlite'),
    storageRoot: resolve(env.PORTAL_STORAGE_ROOT ?? './data/storage'),
    ...(env.PORTAL_TENANTS_FILE ? { tenantsFile: resolve(env.PORTAL_TENANTS_FILE) } : {}),
    ...(env.PORTAL_DISPLAY_NAME?.trim()
      ? { displayName: env.PORTAL_DISPLAY_NAME.trim() }
      : {}),
    currency: loadCurrency(env),
    ...loadSso(env),
    smtp: loadSmtpConfig(env),
  };
}

function loadSso(env: NodeJS.ProcessEnv): Pick<PortalConfig, 'sso'> {
  const raw = env.PORTAL_SSO_CALLBACK_ORIGIN?.trim();
  // Read even with no provider, so a malformed origin fails at startup and not later.
  const origin = raw ? callbackOrigin(raw, 'PORTAL_SSO_CALLBACK_ORIGIN') : null;
  const providers = ssoProvidersOf(env);
  return origin !== null && Object.keys(providers).length > 0
    ? { sso: { callbackOrigin: origin, providers } }
    : {};
}

function loadCurrency(env: NodeJS.ProcessEnv): string {
  const code = env.PORTAL_CURRENCY?.trim();
  if (!code) return DEFAULT_PORTAL_CURRENCY;
  if (!isCurrencyCode(code)) {
    throw new Error(
      `PORTAL_CURRENCY is "${code}", which is not an ISO 4217 currency code such as EUR or USD.`,
    );
  }
  return code;
}

function loadSmtpConfig(env: NodeJS.ProcessEnv): SharedSmtpConfig | undefined {
  const host = env.PORTAL_SMTP_HOST;
  if (!host) return undefined;
  const adminEmail = env.PORTAL_ADMIN_EMAIL;
  if (!adminEmail) {
    throw new Error(
      'PORTAL_SMTP_HOST is set but PORTAL_ADMIN_EMAIL is missing — the admin ' +
        'has no address to notify. Set PORTAL_ADMIN_EMAIL or unset PORTAL_SMTP_HOST ' +
        'to fall back to console notifications.',
    );
  }
  const from = env.PORTAL_SMTP_FROM?.trim();
  return {
    host,
    port: Number(env.PORTAL_SMTP_PORT ?? 587),
    secure: env.PORTAL_SMTP_SECURE === 'true',
    user: env.PORTAL_SMTP_USER,
    pass: env.PORTAL_SMTP_PASS,
    ...(from ? { from } : {}),
    adminEmail,
  };
}
