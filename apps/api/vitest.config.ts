import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/test/global-setup.ts'],
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/test/**/*.test.ts'],
    hookTimeout: 180_000,
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
