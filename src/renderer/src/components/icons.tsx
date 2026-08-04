/**
 * Pane-layout icons. The filled half shows where the new pane will appear, which
 * the previous glyphs (⬓ / ⬒) failed to convey — they read as the same shape.
 */

const frame = {
  x: 1.5,
  y: 2.5,
  width: 13,
  height: 11
}

export function SplitRightIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <rect
        {...frame}
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect x="8" y="2.5" width="6.5" height="11" fill="currentColor" opacity="0.45" />
      <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export function SplitDownIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <rect
        {...frame}
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect x="1.5" y="8" width="13" height="5.5" fill="currentColor" opacity="0.45" />
      <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" />
      <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}
