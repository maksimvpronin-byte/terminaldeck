/**
 * Which part of a row the pointer is over, when the row can be landed *in* as
 * well as *beside*.
 *
 * A folder row has to answer two questions at once — sort me here, or put this
 * inside me — and the answer is where in the row the pointer is. A quarter at
 * each end is enough to hit without aiming and leaves half the row meaning
 * "inside", which is the drop the tree has always had and the one that must not
 * become harder. Held apart from the tree so the arithmetic can be read and
 * tested without a DOM.
 */
export function dropZone(
  rect: { top: number; bottom: number; height: number },
  clientY: number
): 'before' | 'after' | 'inside' {
  const edge = rect.height / 4
  if (clientY < rect.top + edge) return 'before'
  if (clientY > rect.bottom - edge) return 'after'
  return 'inside'
}

/** The same question for a row that can only be landed beside: above or below. */
export function dropSide(
  rect: { top: number; height: number },
  clientY: number
): 'before' | 'after' {
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}
