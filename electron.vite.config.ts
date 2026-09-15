import { readFileSync } from 'fs'
import { builtinModules } from 'module'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const { dependencies } = JSON.parse(readFileSync(resolve('package.json'), 'utf-8'))

// Everything the app declares as a runtime dependency stays out of the main and
// preload bundles, and is required at run time from the `node_modules` that
// electron-builder ships beside them. Said as a rollup external list rather than
// through electron-vite's own option, because that option is spelled differently
// in the versions this repo has been built with, and a dependency that ends up
// bundled does not fail loudly: rollup replaces ws's optional `bufferutil` with
// an empty module, so ws's `try { require('bufferutil') }` succeeds and the
// missing `unmask` surfaces only as a crash on the first masked frame the RDP
// gateway receives. ssh2's native crypto stops loading the same silent way.
const external = [
  'electron',
  /^node:/,
  ...builtinModules,
  ...Object.keys(dependencies ?? {}).map((dep) => new RegExp(`^${dep}(/|$)`))
]

export default defineConfig({
  main: {
    build: { rollupOptions: { external } },
    resolve: {
      alias: {
        '@main': resolve('src/main')
      }
    }
  },
  preload: {
    build: { rollupOptions: { external } }
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
