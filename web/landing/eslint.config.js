import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// The landing site's lint (from scotho's root config, scoped to web/landing).
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        __APP_VERSION__: 'readonly',
        __BUILD_STAMP__: 'readonly',
      },
    },
  },
  {
    // Node-side code: the inbox, the tools, the configs.
    files: ['api/**/*.mjs', 'tools/**/*.mjs', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // The inboxes strip control characters out of what strangers send; the regexes that do it are the point.
    files: ['api/**/*.mjs'],
    rules: { 'no-control-regex': 'off' },
  },
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      'map-viewer/',       // the viewer build deploy.sh copies in (web/redotcom), not this site's source
      'redotcom/',
      'public/',
      'story.html',
      'test-results/',
      'playwright-report/',
    ],
  },
);
