// Starts the real CAT server for the functional tests (`pnpm test:e2e`), on a
// fresh database that holds one account, so every run begins from the same state.
//
// Playwright runs this as its `webServer` command. The account is created by the
// server's own `create-account` script before the server starts (the same path a
// deploy uses), and the built SPA is served from the server, as in production.
// Nothing here is a second implementation of the server: it only sets the
// environment the server reads (config.ts) and then starts it.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = (name) => join(root, 'packages/server/dist', name);

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
if (!email || !password) {
  throw new Error(
    'E2E_EMAIL and E2E_PASSWORD must be set (playwright.config.ts sets them)',
  );
}

const dataDir = mkdtempSync(join(tmpdir(), 'tessera-e2e-'));
const env = {
  ...process.env,
  CAT_PORT: process.env.E2E_PORT ?? '3401',
  CAT_DB_PATH: join(dataDir, 'platform.sqlite'),
  CAT_STORAGE_ROOT: join(dataDir, 'storage'),
  CAT_WEB_DIR: join(root, 'packages/web/dist'),
};

execFileSync(process.execPath, [dist('create-account.js'), email, password], {
  env,
  stdio: 'inherit',
});

const server = spawn(process.execPath, [dist('main.js')], { env, stdio: 'inherit' });

// Playwright stops this process when the run ends; the server goes with it, and
// the throwaway data directory is removed.
const stop = (signal) => {
  server.kill(signal);
};
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop(signal);
  });
}
server.on('exit', (code) => {
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(code ?? 0);
});
