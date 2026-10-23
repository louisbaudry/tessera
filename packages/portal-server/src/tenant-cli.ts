/**
 * Which tenant's portal a command-line job acts on (backlog #208, `planning/tenant-spec.md`
 * D13). The legacy single portal needs no choice; a registry with several tenants needs
 * `--tenant <id>`, so a command never guesses whose file it is about to change.
 */
import { loadConfig, type PortalConfig } from './config.js';
import {
  loadTenants,
  selectTenant,
  takeTenantOption,
  TenantRegistryError,
  type PortalTenant,
} from './tenants.js';

export interface TenantCommand {
  readonly config: PortalConfig;
  readonly tenant: PortalTenant;
  /** The arguments left after `--tenant`, and after the `--` that `pnpm run` forwards. */
  readonly args: string[];
}

/** Resolves the tenant a script acts on, or prints why not and exits. */
export function tenantCommand(argv: readonly string[]): TenantCommand {
  const args = [...argv];
  // `pnpm run <script> -- <args>` forwards the `--` itself (CLAUDE.md, gotchas).
  if (args[0] === '--') args.shift();
  try {
    const config = loadConfig();
    const { tenantId, rest } = takeTenantOption(args);
    const tenant = selectTenant(loadTenants(config), tenantId);
    return { config, tenant, args: rest };
  } catch (error) {
    if (error instanceof TenantRegistryError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
