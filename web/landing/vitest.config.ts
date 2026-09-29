import { defineConfig } from 'vitest/config';

// The landing site's unit tests: the pages (jsdom), the gallery, and the inbox under api/. The design system's own
// guards run as the `shared` workspace (web/shared/vitest.config.ts).
export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'ds/**/*.test.ts', 'api/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'map-viewer/**', 'redotcom/**', 'e2e/**'],
  },
});
