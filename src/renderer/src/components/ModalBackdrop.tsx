import { useRef } from 'react'
import type { ReactNode, MouseEvent as ReactMouseEvent } from 'react'

/**
 * Dismisses only when the press *starts and ends* on the backdrop. Closing on a
 * plain click loses the dialog when the user drags to select text inside a field
 * and releases the button outside it — the browser reports that as a backdrop click.
 */
export default function ModalBackdrop({
  onClose,
  children
}: {
  onClose: () => void
  children: ReactNode
}): JSX.Element {
  const pressedOnBackdrop = useRef(false)

  function onMouseDown(e: ReactMouseEvent): void {
    pressedOnBackdrop.current = e.target === e.currentTarget
  }

  function onClick(e: ReactMouseEvent): void {
    if (e.target === e.currentTarget && pressedOnBackdrop.current) onClose()
    pressedOnBackdrop.current = false
  }

  return (
    <div className="modal-backdrop" onMouseDown={onMouseDown} onClick={onClick}>
      {children}
    </div>
  )
}
