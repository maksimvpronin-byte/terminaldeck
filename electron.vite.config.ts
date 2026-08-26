import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // What `externalizeDepsPlugin` used to do, before electron-vite 5 deprecated
    // it in favour of this option. Said out loud rather than left to the default,
    // because bundling a dependency instead of externalizing it is how ssh2's
    // native crypto stops loading in a packaged build.
    build: { externalizeDeps: true },
    resolve: {
      alias: {
        '@main': resolve('src/main')
      }
    }
  },
  preload: {
    build: { externalizeDeps: true }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
