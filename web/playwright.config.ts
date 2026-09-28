import { defineConfig, devices } from '@playwright/test';

/**
 * One headless chromium against one Vite dev server, serving the extracted disc tree from
 * `web/public/maps/`. Nothing here runs in parallel: the point is a picture of a map, and the host is
 * shared with the game build.
 *
 * The port is overridable (`E2E_PORT`): 5173 is also Vite's own default for `npm run dev`, so a
 * session already running the dev server -- or another agent's -- can be holding it, and
 * `reuseExistingServer` would then attach to that unrelated server instead of this worktree's source.
 */
const PORT = process.env['E2E_PORT'] ?? '5173';
export default defineConfig({
  testDir: 'packages/viewer/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 60_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: {
      // Headless chromium has no GPU: ANGLE over SwiftShader is what draws, and recent Chrome versions
      // refuse WebGL on SwiftShader without being told the risk is accepted.
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite --config packages/viewer/vite.config.ts --port ${PORT}`,
    url: `http://localhost:${PORT}/maps/index.json`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
  },
});
