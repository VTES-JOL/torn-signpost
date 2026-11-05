import { defineConfig } from 'vitest/config';

/**
 * Integration tests share one DynamoDB Local, which slows down when several test files use it at
 * once; the default 5 s timeout is too tight for whole games played through the service.
 */
export default defineConfig({
  test: { testTimeout: 30_000 },
});
