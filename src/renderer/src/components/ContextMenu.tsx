import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** Renders a divider above this item. */
  separated?: boolean
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export default function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  /**
   * What the rows are, as one string.
   *
   * A menu can be replaced by another one in the same place — choosing "Connect
   * as…" opens the list of accounts where the host menu stood — and the second
   * is regularly a different height from the first. The nudge below is measured
   * from the height, so it has to be taken again when the rows change; without
   * this the accounts list is placed by the arithmetic done for the menu it
   * replaced, and near the bottom of the screen that puts half of it off the
   * edge.
   */
  const rows = items.map((item) => item.label).join('\u0000')

  // Nudge back inside the window when opened near an edge.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = x + rect.width > window.innerWidth ? Math.max(4, x - rect.width) : x
    const top = y + rect.height > window.innerHeight ? Math.max(4, y - rect.height) : y
    setPos({ left, top })
    // `rows` is a trigger rather than an input: nothing in here reads it, and
    // what it stands for — the menu's height — is read from the DOM, which the
    // rule cannot see changing. `items` itself would be a new array on every
    // render, and this would never stop measuring.
  }, [x, y, rows])

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <Fragment key={`${item.label}-${i}`}>
          {item.separated && <div className="context-sep" />}
          <button
            className={item.danger ? 'danger' : ''}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  )
}
