import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CI sets VITEST_TEST_TIMEOUT on Windows only (#82): the starved runner
    // times out a different 5 s test on every run, so one suite at a time is
    // whack-a-mole. Unset (locally, Linux, macOS) leaves vitest's 5 s alone.
    testTimeout: Number(process.env.VITEST_TEST_TIMEOUT) || undefined,
    include: ['packages/*/src/**/*.test.ts'],
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
