import { defineConfig, devices } from '@playwright/test';

// The landing site at 1280 and 390. Goldens are platform-suffixed and compared only where they were cut (the specs
// skip the compare elsewhere); the gallery's are tracked, the home and story goldens show game imagery and stay
// local (git-ignored). E2E_PORT overrides the dev server's port (5180), as the viewer's config does.
const PORT = process.env['E2E_PORT'] ?? '5180';
export default defineConfig({
  testDir: 'e2e',
  snapshotPathTemplate: '{testDir}/goldens/{arg}-{platform}{ext}',
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: { command: `npx vite --port ${PORT} --strictPort`, url: `http://localhost:${PORT}/ds/`, reuseExistingServer: !process.env.CI, timeout: 60000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'phone', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
