#!/usr/bin/env node
// Run after npm run build. Optional argument: a packaged app.asar/out/main directory.
const console = require('node:console')
const { setInterval, clearInterval } = require('node:timers')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { performance } = require('node:perf_hooks')

async function main() {
  const output = path.resolve(process.argv[2] || path.join(__dirname, '../out/main'))
  const entry = fs.readdirSync(output).find((name) => /^inventory\.worker-.*\.js$/.test(name))
  assert(entry, 'Build the app before checking its inventory worker')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-worker-perf-'))
  try {
    const count = 10000
    const hosts = Array.from(
      { length: count },
      (_, i) => `    host-${i}:\n      ansible_host: 10.0.${Math.floor(i / 256)}.${i % 256}\n`
    ).join('')
    fs.writeFileSync(path.join(dir, 'hosts.yml'), `all:\n  hosts:\n${hosts}`)
    let ticks = 0,
      maxGap = 0,
      previous = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - previous)
      previous = now
      ticks++
    }, 10)
    const start = performance.now()
    let result
    try {
      result = await new Promise((resolve, reject) => {
        const worker = new Worker(path.join(output, entry), {
          workerData: {
            dir,
            paths: ['hosts.yml'],
            sourceId: 'perf',
            prefix: 'inv',
            rootId: 'root'
          }
        })
        let message
        worker.once('message', (value) => {
          message = value
        })
        worker.once('error', reject)
        worker.once('exit', (code) =>
          code === 0 && message ? resolve(message) : reject(new Error(`Worker exited ${code}`))
        )
      })
    } finally {
      clearInterval(timer)
    }
    assert.equal(result.hosts.length, count)
    assert(ticks > 0, 'Main event loop did not run during inventory parsing')
    console.log(
      JSON.stringify(
        {
          hosts: count,
          elapsedMs: Math.round(performance.now() - start),
          mainLoopTicks: ticks,
          maxTickGapMs: Math.round(maxGap),
          worker: entry
        },
        null,
        2
      )
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
