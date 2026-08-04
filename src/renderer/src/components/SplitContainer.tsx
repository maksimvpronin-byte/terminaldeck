import { useRef } from 'react'
import type { PaneNode } from '../state/store'
import { useStore } from '../state/store'
import Pane from './Pane'

export default function SplitContainer({ tabId, node }: { tabId: string; node: PaneNode }): JSX.Element {
  const resizeSplit = useStore((s) => s.resizeSplit)

  if (node.type === 'leaf') {
    return <Pane tabId={tabId} node={node} />
  }

  const containerRef = useRef<HTMLDivElement | null>(null)

  function onDragStart(e: React.MouseEvent): void {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const isRow = node.type === 'split' && node.dir === 'row'

    function onMove(ev: MouseEvent): void {
      const pos = isRow ? ev.clientX - rect.left : ev.clientY - rect.top
      const total = isRow ? rect.width : rect.height
      let pct = (pos / total) * 100
      pct = Math.min(80, Math.max(20, pct))
      resizeSplit(tabId, node.id, [pct, 100 - pct])
    }
    function onUp(): void {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const [a, b] = node.children
  const [sa, sb] = node.sizes

  return (
    <div className={`split-container ${node.dir}`} ref={containerRef}>
      <div className="split-child" style={{ flexBasis: `${sa}%` }}>
        <SplitContainer tabId={tabId} node={a} />
      </div>
      <div className="split-divider" onMouseDown={onDragStart} />
      <div className="split-child" style={{ flexBasis: `${sb}%` }}>
        <SplitContainer tabId={tabId} node={b} />
      </div>
    </div>
  )
}
