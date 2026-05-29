import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/engine/**/*.js'],
    coverage: {
      provider: 'v8',
      include:  ['engine/state.js', 'engine/musicxml.js'],
      reporter: ['text', 'html'],
    },
  },
});
