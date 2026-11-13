import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration suites share one Postgres database; run files serially, tests within a file serially.
    fileParallelism: false,
    // The default worker pool crashes on Node 26 ("reading 'config'"); vmForks runs the same tests.
    pool: 'vmForks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: { provider: 'v8', include: ['src/**'], reporter: ['text-summary', 'lcov'] },
  },
});
