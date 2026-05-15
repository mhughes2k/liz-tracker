import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: {
      // Force the deterministic local embedding provider in tests so the
      // worker never tries to reach the production oMLX server (default
      // provider in production is "omlx" — see src/config.ts).
      EMBEDDING_PROVIDER: 'local',
    },
  },
});
