import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'object-storage',
    include: ['src/**/*.test.ts'],
  },
});
