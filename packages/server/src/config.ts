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
  /**
   * The Anthropic API key the Tessera draft engine calls with (backlog #136,
   * `translation-engine-spec.md` §5). Read from the environment only, never a
   * file in the repo, and never logged or returned: unset, the engine is
   * unavailable and a draft run is refused with a plain message.
   */
  readonly anthropicApiKey?: string;
  /**
   * The model id the engine asks for. A placeholder (D13): the benchmark picks
   * the tier, and the id is recorded in every draft's provenance either way.
   */
  readonly draftModel?: string;
}

/** The mid tier, until the D7 benchmark says otherwise (D13). */
export const DEFAULT_DRAFT_MODEL = 'claude-sonnet-5-5';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.CAT_PORT ?? 3400),
    dbPath: resolve(env.CAT_DB_PATH ?? './data/platform.sqlite'),
    storageRoot: resolve(env.CAT_STORAGE_ROOT ?? './data/storage'),
    // An empty value is "unset", as `docker run -e CAT_WEB_DIR=` would mean.
    ...(env.CAT_WEB_DIR ? { webDir: resolve(env.CAT_WEB_DIR) } : {}),
    // As CAT_WEB_DIR: an empty value is unset. There is deliberately no
    // base-URL setting: the one outbound host is fixed in code, so no
    // environment value can point a client's text somewhere else.
    ...(env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}),
    draftModel: env.CAT_DRAFT_MODEL || DEFAULT_DRAFT_MODEL,
  };
}
