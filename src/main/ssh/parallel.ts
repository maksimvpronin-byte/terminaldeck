/** Bounded metadata requests; await all workers even if one fails. */
export async function forEachConcurrent<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
  concurrency = 8
): Promise<void> {
  let next = 0
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await work(items[next++])
    })
  )
  const failure = results.find((r) => r.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}
