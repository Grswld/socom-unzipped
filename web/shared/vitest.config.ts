import { defineConfig } from 'vitest/config';

// The design system's own guards: contrast, tokens, the CSS contract, the fonts, the typewriter (jsdom for its DOM).
export default defineConfig({ test: { globals: true, environment: 'jsdom', include: ['ds/**/*.test.ts'] } });
