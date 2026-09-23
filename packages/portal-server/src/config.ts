/**
 * Environment-driven config. Conservative defaults so `pnpm --filter
 * @cat-tool/portal-server start` works out of the box for local/dev use;
 * a real deployment overrides every one of these via env vars.
 */
import { resolve } from 'node:path';

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string | undefined;
  readonly pass: string | undefined;
  readonly from: string;
  readonly adminEmail: string;
}

export interface PortalConfig {
  readonly port: number;
  readonly dbPath: string;
  readonly storageRoot: string;
  // Set only when PORTAL_SMTP_HOST is configured — absence is the signal
  // to fall back to ConsoleNotificationService (portal-v0-spec.md §5),
  // same "no real email adapter yet" default v0 shipped with.
  readonly smtp: SmtpConfig | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PortalConfig {
  return {
    port: Number(env.PORTAL_PORT ?? 3300),
    dbPath: resolve(env.PORTAL_DB_PATH ?? './data/portal.sqlite'),
    storageRoot: resolve(env.PORTAL_STORAGE_ROOT ?? './data/storage'),
    smtp: loadSmtpConfig(env),
  };
}

function loadSmtpConfig(env: NodeJS.ProcessEnv): SmtpConfig | undefined {
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
  return {
    host,
    port: Number(env.PORTAL_SMTP_PORT ?? 587),
    secure: env.PORTAL_SMTP_SECURE === 'true',
    user: env.PORTAL_SMTP_USER,
    pass: env.PORTAL_SMTP_PASS,
    from: env.PORTAL_SMTP_FROM ?? 'Optime Translation Portal <no-reply@optime.services>',
    adminEmail,
  };
}
