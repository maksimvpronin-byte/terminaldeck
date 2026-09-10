import type { InventoryRead, readInventory } from './readInventory'

type Result = ReturnType<typeof readInventory>
// Bound CPU and memory when several repositories sync at the same time.
let queue: Promise<unknown> = Promise.resolve()
export function parseInWorker(request: InventoryRead): Promise<Result> {
  const run = async (): Promise<Result> => {
    const { default: createWorker } = await import('./inventory.worker?nodeWorker')
    return new Promise((resolve, reject) => {
      const worker = createWorker({ workerData: request })
      let received: Result | undefined
      worker.once('message', (result: Result) => {
        received = result
      })
      worker.once('error', reject)
      worker.once('exit', (code) => {
        if (received && code === 0) resolve(received)
        else reject(new Error(`Inventory worker exited without a result (${code})`))
      })
    })
  }
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}
