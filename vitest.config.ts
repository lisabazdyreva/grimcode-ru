import { defineConfig } from 'vitest/config';

/**
 * The entry's own tests, and only those: without `include` vitest would walk the whole repository
 * and run every package's tests a second time, out of the root, where their `dist` is not built.
 */
export default defineConfig({
  test: {
    include: ['index.test.ts'],
  },
});
