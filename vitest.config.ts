import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A test's limit is vitest's 5 s on a developer's machine, where a slow test
    // is a finding. On CI it is 20 s (issue #276): a loaded shared runner stalled
    // two SQLite-heavy server tests past 5 s once, in code the PR had not touched,
    // each taking about half a second on a quiet machine. Four times the quiet
    // time is the rule CLAUDE.md sets for a slow test (never a skip), and a test
    // that is really slow still fails at 20 s. `VITEST_TEST_TIMEOUT` overrides
    // both (it was set on the Windows runner, #82, which no longer exists).
    testTimeout:
      Number(process.env.VITEST_TEST_TIMEOUT) || (process.env.CI ? 20_000 : undefined),
    include: ['packages/*/src/**/*.test.ts', 'scripts/*.test.ts'],
    // Overriding --exclude on the CLI replaces these rather than adding to
    // them, so the defaults are restated in the gate script's glob usage.
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts'],
    },
  },
});
