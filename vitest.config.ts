import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.unit.ts'],
    globals: true,
    testTimeout: 60000,
  },
});
