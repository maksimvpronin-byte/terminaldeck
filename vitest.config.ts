import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // `.tsx` is included so that a component test is possible at all — under the
    // old pattern one could be written and would simply never run. Nothing
    // matches it yet: a test that renders needs `environment: 'jsdom'` and the
    // dependency behind it, which lands with the dialog tests themselves.
    include: ['src/**/*.test.{ts,tsx}'],
    // The Electron entry points can't run under Node; only pure modules are tested.
    exclude: ['node_modules', 'out', 'dist']
  }
})
