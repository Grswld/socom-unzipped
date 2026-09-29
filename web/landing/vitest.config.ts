import { defineConfig } from 'vitest/config';

// The landing site's unit tests: the pages (jsdom), the gallery, and the inbox under api/. The design system's own
// guards run as the `shared` workspace (web/shared/vitest.config.ts).
export default defineConfig({
  test: {
    globals: true,
    // prepare.mjs makes the generated inputs (story.html, public/story/) before any file loads, for every kind of run
    // (release review MJ-10; pinned by src/inputs.test.ts). `npm test` still runs it first too: it is idempotent.
    globalSetup: ['tools/vitest-prepare.mjs'],
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'ds/**/*.test.ts', 'api/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'map-viewer/**', 'redotcom/**', 'e2e/**'],
  },
});
