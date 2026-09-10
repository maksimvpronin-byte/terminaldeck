import { useEffect, useRef, useState } from 'react'

export const FILE_ROW_HEIGHT = 30
const OVERSCAN = 8

/** Fixed-height rows; keep an editor mounted even when it scrolls out of view. */
export function useVirtualRows(count: number, pinned = -1) {
  const ref = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const measure = (): void => {
    const el = ref.current
    if (!el) return
    setViewport({ top: el.scrollTop, height: el.clientHeight || 600 })
  }
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  // Header and parent row occupy at most two row heights above the entries.
  const start = Math.min(
    Math.max(0, count - 1),
    Math.max(0, Math.floor(viewport.top / FILE_ROW_HEIGHT) - OVERSCAN - 2)
  )
  const end = Math.min(
    count,
    start + Math.ceil(viewport.height / FILE_ROW_HEIGHT) + OVERSCAN * 2 + 2
  )
  const indices = Array.from({ length: end - start }, (_, i) => i + start)
  if (pinned >= 0 && pinned < count && !indices.includes(pinned)) indices.push(pinned)
  return { ref, measure, indices }
}
