import { defineConfig } from 'vitest/config';
// The camera is DOM-facing, so its test needs a window; the other packages are pure and stay on node.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'jsdom' } });
