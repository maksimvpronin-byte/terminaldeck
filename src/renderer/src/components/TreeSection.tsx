import { useState } from 'react'
import type {
  DragEvent as ReactDragEvent,
  HTMLAttributes,
  MouseEvent as ReactMouseEvent,
  ReactNode
} from 'react'
import { Chevron, togglesFolder } from './TreeToggle'
import { dropSide } from '../state/dropZone'

/**
 * The sections under the host tree — the inventory, collections and
 * multi-windows — each folded away whole with its heading, and put in the
 * order their user wants by dragging the heading over another section, the way
 * hosts and folders are sorted.
 *
 * Both are this machine's arrangement of its own screen, kept beside the
 * folded folders in localStorage rather than in the store a backup carries.
 */
export type SectionId = 'inventory' | 'collections' | 'multiWindows'

export const SECTION_IDS: readonly SectionId[] = ['inventory', 'collections', 'multiWindows']

/** A type of its own, so a host or a tab held over a section leaves it dark. */
export const SECTION_MIME = 'application/x-terminaldeck-section'

const ORDER_KEY = 'terminaldeck.sectionOrder'
const FOLDED_KEY = 'terminaldeck.foldedSections'

/**
 * A stored order made whole: what it names, once each, then whatever it does
 * not — a section added in a later version, or one lost to a hand edit —
 * where it stands by default.
 */
export function normaliseOrder(stored: unknown): SectionId[] {
  const named = Array.isArray(stored)
    ? stored.filter(
        (id, i): id is SectionId => SECTION_IDS.includes(id) && stored.indexOf(id) === i
      )
    : []
  return [...named, ...SECTION_IDS.filter((id) => !named.includes(id))]
}

/** The order once `dragged` is let go on the `side` of `target`. */
export function moveSection(
  order: SectionId[],
  dragged: SectionId,
  target: SectionId,
  side: 'before' | 'after'
): SectionId[] {
  if (dragged === target) return order
  const rest = order.filter((id) => id !== dragged)
  const at = rest.indexOf(target)
  if (at < 0) return order
  rest.splice(side === 'before' ? at : at + 1, 0, dragged)
  return rest
}

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Kept for this window only, then; nothing else depends on it.
  }
}

/** What a section is handed to draw its heading and decide on its body. */
export interface SectionControls {
  id: SectionId
  /** Folded and showing only its heading. A filter unfolds it while it is typed. */
  folded: boolean
  toggle: () => void
  expandOnArrowOnly: boolean
}

export interface TreeSections {
  order: SectionId[]
  controls: (id: SectionId) => SectionControls
  /** Every section open — what Expand all asks of the folders inside them too. */
  unfoldAll: () => void
  /** Props for the div a section is drawn in: where a dragged heading may land. */
  frame: (id: SectionId) => HTMLAttributes<HTMLDivElement>
}

export function useTreeSections(filtering: boolean, expandOnArrowOnly: boolean): TreeSections {
  const [order, setOrder] = useState<SectionId[]>(() => normaliseOrder(read(ORDER_KEY)))
  const [folded, setFolded] = useState<Set<SectionId>>(
    () => new Set(normaliseFolded(read(FOLDED_KEY)))
  )
  const [over, setOver] = useState<{ id: SectionId; side: 'before' | 'after' } | null>(null)

  function changeFolded(next: Set<SectionId>): void {
    write(FOLDED_KEY, [...next])
    setFolded(next)
  }

  function allow(e: ReactDragEvent<HTMLDivElement>, id: SectionId): void {
    if (!e.dataTransfer.types.includes(SECTION_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const side = dropSide(e.currentTarget.getBoundingClientRect(), e.clientY)
    if (over?.id !== id || over.side !== side) setOver({ id, side })
  }

  function drop(e: ReactDragEvent<HTMLDivElement>, id: SectionId): void {
    const dragged = e.dataTransfer.getData(SECTION_MIME) as SectionId
    setOver(null)
    if (!SECTION_IDS.includes(dragged)) return
    e.preventDefault()
    const side = dropSide(e.currentTarget.getBoundingClientRect(), e.clientY)
    const next = moveSection(order, dragged, id, side)
    write(ORDER_KEY, next)
    setOrder(next)
  }

  // Props for a plain div rather than a component made here: one made inside
  // the hook would be a new type on every render, and the panel in it would
  // lose its state each time.
  function frame(id: SectionId): HTMLAttributes<HTMLDivElement> {
    const mark = over?.id === id ? ` drop-${over.side}` : ''
    return {
      className: `tree-section${mark}`,
      onDragOver: (e) => allow(e, id),
      onDragLeave: (e) => {
        // Moving between the rows inside the section is not leaving it.
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        setOver((cur) => (cur?.id === id ? null : cur))
      },
      onDrop: (e) => drop(e, id)
    }
  }

  return {
    order,
    controls: (id) => ({
      id,
      folded: !filtering && folded.has(id),
      toggle: () => {
        const next = new Set(folded)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        changeFolded(next)
      },
      expandOnArrowOnly
    }),
    unfoldAll: () => changeFolded(new Set()),
    frame
  }
}

function normaliseFolded(stored: unknown): SectionId[] {
  return Array.isArray(stored)
    ? stored.filter((id): id is SectionId => SECTION_IDS.includes(id))
    : []
}

/**
 * A section's heading: its arrow and name, which fold it, and the buttons at
 * the right, which do not. Without controls — a panel drawn on its own, as
 * the tests draw them — it is the plain heading it always was.
 */
export function SectionHeading({
  section,
  title,
  children
}: {
  section?: SectionControls
  title: string
  children?: ReactNode
}): JSX.Element {
  if (!section) {
    return (
      <div className="tree-group-title collections-heading">
        <span>{title}</span>
        {children}
      </div>
    )
  }
  const onClick = (e: ReactMouseEvent): void => {
    if (e.target instanceof Element && e.target.closest('button')) return
    if (togglesFolder(e, section.expandOnArrowOnly)) section.toggle()
  }
  return (
    <div
      className="tree-group-title collections-heading section-heading"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SECTION_MIME, section.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={onClick}
      aria-expanded={!section.folded}
    >
      <span className={`section-title ${section.folded ? '' : 'open'}`}>
        <Chevron open={!section.folded} />
        {title}
      </span>
      {children}
    </div>
  )
}
