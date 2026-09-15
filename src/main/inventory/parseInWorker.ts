import type { InventoryRead, readInventory } from './readInventory'

type Result = ReturnType<typeof readInventory>
/**
 * How long one parse may run. An inventory that sends the YAML parser into a
 * pathological case would otherwise hold the queue below — and with it every
 * other source's sync — for good.
 */
const PARSE_TIMEOUT_MS = 2 * 60_000

// Bound CPU and memory when several repositories sync at the same time.
let queue: Promise<unknown> = Promise.resolve()
export function parseInWorker(request: InventoryRead): Promise<Result> {
  const run = async (): Promise<Result> => {
    const { default: createWorker } = await import('./inventory.worker?nodeWorker')
    return new Promise((resolve, reject) => {
      const worker = createWorker({ workerData: request })
      let received: Result | undefined
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        void worker.terminate()
      }, PARSE_TIMEOUT_MS)
      worker.once('message', (result: Result) => {
        received = result
      })
      worker.once('error', reject)
      worker.once('exit', (code) => {
        clearTimeout(timer)
        if (timedOut) reject(new Error('Reading the inventory took too long and was stopped'))
        else if (received && code === 0) resolve(received)
        else reject(new Error(`Inventory worker exited without a result (${code})`))
      })
    })
  }
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}
