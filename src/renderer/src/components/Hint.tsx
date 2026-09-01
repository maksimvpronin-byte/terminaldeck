import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A question mark beside a control, holding what used to be a paragraph.
 *
 * These dialogs explain themselves at length, and the explanations are worth
 * having — but read once. Left on the page they push the controls apart until a
 * dialog with six settings needs scrolling, and the settings themselves become
 * hard to see among the prose about them.
 *
 * Two things this deliberately does rather than the obvious:
 *
 * It is a `button`, not a `span` with a hover. A description reachable only by
 * pointer is a description somebody using the keyboard cannot read at all, and
 * a button is focusable, announced, and understood by every assistive tool
 * without being told.
 *
 * And the bubble is drawn in a portal at coordinates measured from the button,
 * rather than positioned inside it. Every dialog here scrolls, and a tooltip
 * inside something that scrolls is a tooltip clipped by it — which is fine
 * until the control that needs explaining is the last one in the list.
 */
export default function Hint({
  label,
  children
}: {
  /**
   * The caption this belongs to, when it has one.
   *
   * A `label` here lays its children out in a column — the caption, then the
   * control — so a mark dropped in beside the caption became a row of its own
   * with a lonely question mark on it. Given the caption, this renders both on
   * one line and the column sees a single child. Left out, the mark is just the
   * mark: a checkbox row, a heading and a summary are all laid out along the
   * line already.
   */
  label?: ReactNode
  children: ReactNode
}): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ left: number; top: number }>({ left: 0, top: 0 })

  /**
   * Placed after it exists, so its own size can be part of the arithmetic: it
   * goes below the mark, and above instead when there is no room below.
   */
  useLayoutEffect(() => {
    if (!open) return
    const mark = buttonRef.current?.getBoundingClientRect()
    const bubble = bubbleRef.current?.getBoundingClientRect()
    if (!mark || !bubble) return

    const margin = 8
    const left = Math.max(margin, Math.min(mark.left, window.innerWidth - bubble.width - margin))
    const below = mark.bottom + 6
    const top =
      below + bubble.height + margin > window.innerHeight
        ? Math.max(margin, mark.top - bubble.height - 6)
        : below
    setAt({ left, top })
  }, [open])

  const mark = (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="hint-mark"
        aria-label="What this does"
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        // A tap has no hover: on a touch screen this is the only way in.
        onClick={(e) => {
          e.preventDefault()
          setOpen((was) => !was)
        }}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      >
        ?
      </button>
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            role="tooltip"
            className="hint-bubble"
            style={{ left: at.left, top: at.top }}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  )

  return label === undefined ? (
    mark
  ) : (
    <span className="hint-label">
      {label}
      {mark}
    </span>
  )
}
