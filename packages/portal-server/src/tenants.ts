/**
 * The portal's tenant registry (backlog #208, `planning/tenant-spec.md` D13, O2): which
 * tenants this server hosts, and for each its own `portal.sqlite`, its own storage folder
 * and the host its clients and admin reach it at. One app per tenant is built from an entry
 * (`gateway.ts`), so two tenants share no file, no folder and no query, by construction.
 *
 * Parsing is where that is enforced: a registry in which two entries share a number, a host,
 * a database file or a folder, or in which one folder sits inside another, is refused, because
 * an overlap would quietly undo the isolation the rest of the design relies on.
 *
 * With no registry (`PORTAL_TENANTS_FILE` unset) the portal is the one it always was: a single
 * tenant from `PORTAL_DB_PATH` and `PORTAL_STORAGE_ROOT`, answering any host (`legacyTenant`), so
 * the first tenant's existing file needs no move and no change (D12).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import { normaliseHost } from '@cat-tool/portal-core';

import type { PortalConfig, SmtpConfig } from './config.js';

export interface PortalTenant {
  /** The CAT platform's number for this tenant; `null` only for the legacy single portal. */
  readonly tenantId: number | null;
  /** The host this tenant's portal answers at (lower case, no port); `null`: any host (legacy only). */
  readonly host: string | null;
  readonly dbPath: string;
  readonly storageRoot: string;
  /** The sender of this tenant's clients' mail; the shared transport's default when omitted. */
  readonly from?: string;
  /** Where this tenant's admin is notified; the shared default when omitted. */
  readonly adminEmail?: string;
}

/** A registry that cannot be used, or a tenant that is not in it. The message says which. */
export class TenantRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantRegistryError';
  }
}

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const KEYS = new Set(['tenantId', 'host', 'dbPath', 'storageRoot', 'from', 'adminEmail']);

const isInside = (inner: string, outer: string): boolean =>
  inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);

function text(entry: Record<string, unknown>, key: string, where: string): string {
  const value = entry[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TenantRegistryError(`${where}: ${key} must be a non-empty text`);
  }
  return value;
}

/**
 * Reads a registry's text. Relative paths are taken from `baseDir`, the registry's own folder,
 * so a registry and the files it names move together.
 *
 * @throws {TenantRegistryError} for text that is not a registry, an unknown key, a bad value,
 *   or entries that overlap.
 */
export function parseTenantRegistry(source: string, baseDir: string): PortalTenant[] {
  let root: unknown;
  try {
    root = JSON.parse(source);
  } catch {
    throw new TenantRegistryError('the tenant registry is not JSON');
  }
  const list = (root as { tenants?: unknown } | null)?.tenants;
  if (typeof root !== 'object' || root === null || !Array.isArray(list)) {
    throw new TenantRegistryError('the tenant registry is { "tenants": [ ... ] }');
  }
  if (list.length === 0) {
    throw new TenantRegistryError('the tenant registry needs at least one tenant');
  }
  const tenants = list.map((raw, index): PortalTenant => {
    const where = `tenant entry ${index + 1}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TenantRegistryError(`${where} is not an object`);
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!KEYS.has(key)) throw new TenantRegistryError(`${where}: unknown key "${key}"`);
    }
    const tenantId = entry.tenantId;
    if (typeof tenantId !== 'number' || !Number.isSafeInteger(tenantId) || tenantId < 1) {
      throw new TenantRegistryError(`${where}: tenantId must be a positive whole number`);
    }
    const hostText = text(entry, 'host', where);
    const host = hostText.toLowerCase().replace(/\.$/, '');
    if (!HOST.test(host) || hostText.includes(':')) {
      throw new TenantRegistryError(
        `${where}: host "${hostText}" is not a plain host name`,
      );
    }
    const tenant: PortalTenant = {
      tenantId,
      host,
      dbPath: resolve(baseDir, text(entry, 'dbPath', where)),
      storageRoot: resolve(baseDir, text(entry, 'storageRoot', where)),
      ...(entry.from === undefined ? {} : { from: text(entry, 'from', where) }),
      ...(entry.adminEmail === undefined
        ? {}
        : { adminEmail: text(entry, 'adminEmail', where) }),
    };
    return tenant;
  });
  assertNoOverlap(tenants);
  return tenants;
}

function assertNoOverlap(tenants: readonly PortalTenant[]): void {
  for (const [i, a] of tenants.entries()) {
    for (const b of tenants.slice(i + 1)) {
      if (a.tenantId === b.tenantId) {
        throw new TenantRegistryError(`tenant #${a.tenantId} twice`);
      }
      if (a.host === b.host) {
        throw new TenantRegistryError(
          `tenants #${a.tenantId} and #${b.tenantId} share the host "${a.host}"`,
        );
      }
      if (a.dbPath === b.dbPath) {
        throw new TenantRegistryError(
          `tenants #${a.tenantId} and #${b.tenantId} share a database file`,
        );
      }
      if (a.storageRoot === b.storageRoot) {
        throw new TenantRegistryError(
          `tenants #${a.tenantId} and #${b.tenantId} share a storage folder`,
        );
      }
      for (const [outer, inner] of [
        [a, b],
        [b, a],
      ] as const) {
        if (isInside(inner.storageRoot, outer.storageRoot)) {
          throw new TenantRegistryError(
            `tenant #${inner.tenantId}'s storage folder is inside tenant #${outer.tenantId}'s`,
          );
        }
      }
    }
  }
  for (const t of tenants) {
    for (const other of tenants) {
      if (isInside(t.dbPath, other.storageRoot)) {
        throw new TenantRegistryError(
          `tenant #${t.tenantId}'s database is inside tenant #${other.tenantId}'s storage folder`,
        );
      }
    }
  }
}

/** A registry as text: what `add-portal-tenant` writes. Paths are written absolute. */
export function serializeTenantRegistry(tenants: readonly PortalTenant[]): string {
  return (
    JSON.stringify(
      {
        tenants: tenants.map((t) => ({
          tenantId: t.tenantId,
          host: t.host,
          dbPath: t.dbPath,
          storageRoot: t.storageRoot,
          ...(t.from === undefined ? {} : { from: t.from }),
          ...(t.adminEmail === undefined ? {} : { adminEmail: t.adminEmail }),
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

export function readTenantRegistry(file: string): PortalTenant[] {
  return parseTenantRegistry(readFileSync(file, 'utf8'), dirname(resolve(file)));
}

/** The portal as it always was: one tenant from the configured paths, on any host. */
export function legacyTenant(config: PortalConfig): PortalTenant {
  return {
    tenantId: null,
    host: null,
    dbPath: config.dbPath,
    storageRoot: config.storageRoot,
  };
}

/** The tenants this server hosts: the registry when one is configured, else the legacy portal. */
export function loadTenants(config: PortalConfig): PortalTenant[] {
  return config.tenantsFile === undefined
    ? [legacyTenant(config)]
    : readTenantRegistry(config.tenantsFile);
}

/** A portal's config once its sender is settled: what `buildApp` takes. */
export type TenantPortalConfig = Omit<PortalConfig, 'smtp'> & {
  readonly smtp: SmtpConfig | undefined;
};

/**
 * The config one tenant's app is built from: its own file and folder, and over the operator's
 * shared SMTP transport its own sender and admin address. Nothing else of one tenant's is
 * reachable from another's config.
 *
 * @throws {TenantRegistryError} if SMTP is configured and the tenant has no sender, neither its
 *   own `from` nor the shared `PORTAL_SMTP_FROM`: there is no default, because a default would
 *   mail a tenant's clients in someone else's name (issue #306, `tenant-spec.md` D12).
 */
export function configForTenant(
  config: PortalConfig,
  tenant: PortalTenant,
): TenantPortalConfig {
  const { smtp: shared, ...rest } = config;
  if (shared === undefined) {
    return {
      ...rest,
      dbPath: tenant.dbPath,
      storageRoot: tenant.storageRoot,
      smtp: undefined,
    };
  }
  const from = tenant.from ?? shared.from;
  if (!from) {
    throw new TenantRegistryError(
      `PORTAL_SMTP_HOST is set but ${
        tenant.tenantId === null ? 'the portal' : `tenant ${tenant.tenantId}`
      } has no sender: set PORTAL_SMTP_FROM${
        tenant.tenantId === null ? '' : ` or this tenant's "from" in the registry`
      }, or unset PORTAL_SMTP_HOST to fall back to console notifications.`,
    );
  }
  return {
    ...rest,
    dbPath: tenant.dbPath,
    storageRoot: tenant.storageRoot,
    smtp: { ...shared, from, adminEmail: tenant.adminEmail ?? shared.adminEmail },
  };
}

/**
 * Takes `--tenant <id>` or `--tenant=<id>` out of a command's arguments, wherever it is, leaving
 * the rest in order. `pnpm run <script> -- <args>` forwards its own `--`, which the caller strips.
 *
 * @throws {TenantRegistryError} for a `--tenant` with no usable number.
 */
export function takeTenantOption(args: readonly string[]): {
  tenantId: number | null;
  rest: string[];
} {
  const rest: string[] = [];
  let tenantId: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg === '--tenant') value = args[++i];
    else if (arg.startsWith('--tenant=')) value = arg.slice('--tenant='.length);
    else {
      rest.push(arg);
      continue;
    }
    const n = Number(value);
    if (value === undefined || !Number.isSafeInteger(n) || n < 1) {
      throw new TenantRegistryError('--tenant takes a tenant number, such as --tenant 2');
    }
    tenantId = n;
  }
  return { tenantId, rest };
}

/**
 * The tenant a command acts on. The legacy single portal needs none; a registry with several
 * needs `--tenant`, so a command never guesses which tenant's file it is about to change.
 */
export function selectTenant(
  tenants: readonly PortalTenant[],
  tenantId: number | null,
): PortalTenant {
  const legacy = tenants.length === 1 && tenants[0]!.tenantId === null;
  if (legacy) {
    if (tenantId !== null) {
      throw new TenantRegistryError(
        `no tenant registry is configured (PORTAL_TENANTS_FILE), so there is no tenant #${tenantId}`,
      );
    }
    return tenants[0]!;
  }
  if (tenantId === null) {
    if (tenants.length === 1) return tenants[0]!;
    throw new TenantRegistryError(
      `--tenant <id> is needed: the registry has ${tenants.map((t) => `#${t.tenantId}`).join(', ')}`,
    );
  }
  const found = tenants.find((t) => t.tenantId === tenantId);
  if (!found) throw new TenantRegistryError(`no tenant #${tenantId} in the registry`);
  return found;
}

/**
 * The registry with `tenant` added, or an error if it would overlap an entry already there
 * (the same rules as reading one). Where `add-portal-tenant` checks before it creates anything.
 */
export function addTenant(
  existing: readonly PortalTenant[],
  tenant: PortalTenant,
): PortalTenant[] {
  return parseTenantRegistry(serializeTenantRegistry([...existing, tenant]), '/');
}

/** Where a tenant's file and folder go when the operator names none: beside the registry, by number. */
export function defaultTenantPaths(
  registryFile: string,
  tenantId: number,
): { dbPath: string; storageRoot: string } {
  const base = resolve(dirname(resolve(registryFile)), `t${tenantId}`);
  return {
    dbPath: resolve(base, 'portal.sqlite'),
    storageRoot: resolve(base, 'storage'),
  };
}

/** Re-exported: the one definition is `@cat-tool/core`'s (`net/host.ts`), shared with the CAT server. */
export { normaliseHost };
