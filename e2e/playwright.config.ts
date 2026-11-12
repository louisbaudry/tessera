/**
 * The functional tests: a real browser, driving the built SPA against the real
 * server (`e2e/serve.mjs`). They run after `pnpm build`, which `pnpm test:e2e`
 * does first, because the server serves `packages/web/dist` and `packages/server/dist`.
 *
 * Not part of `pnpm test` (vitest only collects `packages/*\/src` and `scripts`),
 * so a machine with no browser still runs the unit suite. CI runs them in their
 * own job, the way the golden and OOXML jobs are kept apart.
 *
 * A locally pre-installed Chromium can be used with `E2E_CHROMIUM_PATH`; in CI
 * the browser comes from `playwright install` in the workflow.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3401);
const baseURL = `http://localhost:${PORT}`;

// The one account the server is started with. Test-only values, never a real person:
// `example.test` is reserved, and serve.mjs makes a fresh database around it each run.
process.env.E2E_EMAIL ??= 'tester@example.test';
process.env.E2E_PASSWORD ??= 'e2e-only-password';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // One server and one database for the whole run: the tests share it in order.
  // Parallel workers would make a project one test created visible to another.
  workers: 1,
  fullyParallel: false,
  // A retry would hide a flaky test rather than fix it (CLAUDE.md: never weaken a
  // test to get green), so a failure is reported once.
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    // Traces cost a third of a run's CPU (CLAUDE.md); kept only for a CI failure.
    trace: process.env.CI ? 'retain-on-failure' : 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
        },
      },
    },
  ],
  webServer: {
    command: 'node e2e/serve.mjs',
    cwd: new URL('..', import.meta.url).pathname,
    url: baseURL,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 60_000,
  },
});
