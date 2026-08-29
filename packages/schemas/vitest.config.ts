import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'schemas',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
