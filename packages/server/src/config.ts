/**
 * Environment-driven config (v1-spec.md §2.5). Conservative defaults so
 * `pnpm --filter @cat-tool/server start` works out of the box locally;
 * a deployment (backlog #36) overrides every one of these.
 */
import { resolve } from 'node:path';

export interface ServerConfig {
  readonly port: number;
  /** `platform.sqlite` — accounts and sessions, never translation data (§4.1a). */
  readonly dbPath: string;
  /** The volume every account's storage root lives under. */
  readonly storageRoot: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.CAT_PORT ?? 3400),
    dbPath: resolve(env.CAT_DB_PATH ?? './data/platform.sqlite'),
    storageRoot: resolve(env.CAT_STORAGE_ROOT ?? './data/storage'),
  };
}
