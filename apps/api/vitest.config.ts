import { defineConfig } from 'vitest/config';

// Vitest's transformer does not emit decorator metadata, so every Nest constructor
// dependency MUST use an explicit @Inject(Token) (project rule, see CLAUDE.md).
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
  },
});
