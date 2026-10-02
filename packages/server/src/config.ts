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
  /**
   * The built SPA (`packages/web/dist`), served at `/` when set. Unset in
   * development, where Vite serves the SPA and proxies `/api` here; set by
   * the container image (backlog #36), which has one process to reach.
   */
  readonly webDir?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.CAT_PORT ?? 3400),
    dbPath: resolve(env.CAT_DB_PATH ?? './data/platform.sqlite'),
    storageRoot: resolve(env.CAT_STORAGE_ROOT ?? './data/storage'),
    // An empty value is "unset", as `docker run -e CAT_WEB_DIR=` would mean.
    ...(env.CAT_WEB_DIR ? { webDir: resolve(env.CAT_WEB_DIR) } : {}),
  };
}
