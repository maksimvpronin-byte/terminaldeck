import { useEffect, useRef, useState } from 'react'
import type { PaneNode } from '../state/store'
import { useStore } from '../state/store'
import Pane from './Pane'

type LeafNode = Extract<PaneNode, { type: 'leaf' }>
type SplitNode = Extract<PaneNode, { type: 'split' }>

const DIVIDER_PX = 4

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

interface LeafLayout {
  leaf: LeafNode
  rect: Rect
}

interface DividerLayout {
  splitId: string
  dir: 'row' | 'col'
  rect: Rect
  parentRect: Rect
}

function computeLayout(
  node: PaneNode,
  rect: Rect,
  leaves: LeafLayout[],
  dividers: DividerLayout[]
): void {
  if (node.type === 'leaf') {
    leaves.push({ leaf: node, rect })
    return
  }
  const split = node as SplitNode
  const [a, b] = split.children
  const [sa, sb] = split.sizes

  if (split.dir === 'row') {
    const avail = Math.max(0, rect.width - DIVIDER_PX)
    const wa = (avail * sa) / 100
    const wb = (avail * sb) / 100
    dividers.push({
      splitId: split.id,
      dir: 'row',
      rect: { left: rect.left + wa, top: rect.top, width: DIVIDER_PX, height: rect.height },
      parentRect: rect
    })
    computeLayout(a, { left: rect.left, top: rect.top, width: wa, height: rect.height }, leaves, dividers)
    computeLayout(
      b,
      { left: rect.left + wa + DIVIDER_PX, top: rect.top, width: wb, height: rect.height },
      leaves,
      dividers
    )
  } else {
    const avail = Math.max(0, rect.height - DIVIDER_PX)
    const ha = (avail * sa) / 100
    const hb = (avail * sb) / 100
    dividers.push({
      splitId: split.id,
      dir: 'col',
      rect: { left: rect.left, top: rect.top + ha, width: rect.width, height: DIVIDER_PX },
      parentRect: rect
    })
    computeLayout(a, { left: rect.left, top: rect.top, width: rect.width, height: ha }, leaves, dividers)
    computeLayout(
      b,
      { left: rect.left, top: rect.top + ha + DIVIDER_PX, width: rect.width, height: hb },
      leaves,
      dividers
    )
  }
}

export default function SplitContainer({ tabId, node }: { tabId: string; node: PaneNode }): JSX.Element {
  const resizeSplit = useStore((s) => s.resizeSplit)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      // A hidden tab reports 0x0; keep the last real size so panes stay mounted.
      if (box && box.width > 0 && box.height > 0) {
        setSize({ width: box.width, height: box.height })
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const leaves: LeafLayout[] = []
  const dividers: DividerLayout[] = []
  if (size.width > 0 && size.height > 0) {
    computeLayout(node, { left: 0, top: 0, width: size.width, height: size.height }, leaves, dividers)
  }

  function onDragStart(divider: DividerLayout, e: React.MouseEvent): void {
    e.preventDefault()
    const isRow = divider.dir === 'row'
    const { parentRect } = divider

    function onMove(ev: MouseEvent): void {
      const containerBox = containerRef.current?.getBoundingClientRect()
      if (!containerBox) return
      const localX = ev.clientX - containerBox.left
      const localY = ev.clientY - containerBox.top
      const pos = isRow ? localX - parentRect.left : localY - parentRect.top
      const total = isRow ? parentRect.width : parentRect.height
      let pct = (pos / total) * 100
      pct = Math.min(80, Math.max(20, pct))
      resizeSplit(tabId, divider.splitId, [pct, 100 - pct])
    }
    function onUp(): void {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="split-root" ref={containerRef}>
      {leaves.map(({ leaf, rect }) => (
        <div
          key={leaf.id}
          className="split-leaf-abs"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        >
          <Pane tabId={tabId} node={leaf} />
        </div>
      ))}
      {dividers.map((d) => (
        <div
          key={d.splitId}
          className={`split-divider-abs ${d.dir}`}
          style={{ left: d.rect.left, top: d.rect.top, width: d.rect.width, height: d.rect.height }}
          onMouseDown={(e) => onDragStart(d, e)}
        />
      ))}
    </div>
  )
}
