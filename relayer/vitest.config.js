import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    hookTimeout: 15000,
    testTimeout: 15000,
  },
});
