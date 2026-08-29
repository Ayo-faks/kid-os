import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['src/**/*.test.ts', 'prisma/__tests__/**/*.test.ts'],
    passWithNoTests: true,
  },
});
