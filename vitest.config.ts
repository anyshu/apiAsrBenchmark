import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    api: {
      host: '127.0.0.1',
    },
  },
});
