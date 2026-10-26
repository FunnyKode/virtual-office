import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // The 3D scene needs WebGL and is checked in a browser; its pure logic is covered here.
      include: ['src/**/*.ts', 'scripts/**/*.ts', 'hooks/**/*.mjs', 'public/office/logic/**/*.js'],
      exclude: ['src/server/main.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
