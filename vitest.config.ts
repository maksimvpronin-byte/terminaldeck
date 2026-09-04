import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    // Node by default, because nearly everything tested here is a pure module
    // and a DOM per file is not free. A component test asks for the browser it
    // needs with `// @vitest-environment jsdom` at the top of the file, which
    // also keeps that dependency visible in the test rather than in a config
    // nobody reads.
    environment: 'node',
    setupFiles: ['src/renderer/src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // The Electron entry points can't run under Node; only pure modules and
    // components are tested.
    exclude: ['node_modules', 'out', 'dist']
  }
})
