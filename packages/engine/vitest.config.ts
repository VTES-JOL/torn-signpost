import { defineConfig } from 'vitest/config';

/**
 * Engine coverage is enforced (docs/testing.md): the thresholds are a floor that only goes up. When
 * a change raises coverage, raise them to match (rounded down); never lower them to get a change
 * through: add the scenario or test instead.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/testing/**'],
      reporter: ['text-summary', 'text'],
      thresholds: { statements: 90, branches: 83, functions: 93, lines: 94 },
    },
  },
});
