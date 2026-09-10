/** Limit UI progress at the producer; completion always bypasses the interval. */
export function transferProgress<T extends { transferred: number; total: number }>(
  send: (value: T) => void,
  interval = 100
): (value: T) => void {
  let last = -Infinity
  return (value) => {
    const now = performance.now()
    if (value.transferred < value.total && now - last < interval) return
    last = now
    send(value)
  }
}
