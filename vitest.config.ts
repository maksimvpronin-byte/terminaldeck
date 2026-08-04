import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The Electron entry points can't run under Node; only pure modules are tested.
    exclude: ['node_modules', 'out', 'dist']
  }
})
