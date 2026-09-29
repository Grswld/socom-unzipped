import { defineConfig } from 'vitest/config';
// The server is Node: no DOM.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } });
