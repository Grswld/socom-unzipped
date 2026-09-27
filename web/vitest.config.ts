import { defineConfig } from 'vitest/config';

// vitest 3 deprecated the workspace file; the same per-package configs are listed here instead.
export default defineConfig({ test: { projects: ['packages/*/vitest.config.ts'] } });
