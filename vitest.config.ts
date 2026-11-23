import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // Real-time tests (simulated flights, AI follow-me at 3 frames a second) need some CPU to spare.
    maxWorkers: 3,
    // Tests that measure how long the server could not answer collect the garbage of their own
    // set-up first (globalThis.gc): only the server's work is measured.
    execArgv: ['--expose-gc'],
  },
});
