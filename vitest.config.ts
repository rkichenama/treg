import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      // Every run reports coverage and fails under the thresholds.
      enabled: true,
      provider: 'v8',
      include: ['src'],
      // `html` is what Vitest UI (`pnpm test:ui`) shows in its coverage tab.
      reporter: ['text', 'html'],
      reportsDirectory: '@coverage',
      thresholds: {
        branches: 80,
        functions: 80,
      },
    },
  },
});
