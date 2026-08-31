/**
 * Dragging rows out of one file panel and onto another.
 *
 * The rules are small but not obvious, and until now they were three lines
 * inside a thousand-line component, reachable only by dragging a file between
 * two live SSH sessions.
 */

/** Rows dragged out of an SFTP panel, as opposed to files from the desktop. */
export const SFTP_DRAG = 'application/x-td-sftp'

export interface SftpDragPayload {
  connectionId: string
  paths: string[]
}

/**
 * What is currently being dragged out of some panel, for as long as it lasts.
 *
 * `dataTransfer` refuses to hand over its payload during `dragover` — only the
 * list of types is readable then — so without this a panel could not tell rows
 * from another host apart from the ones being dragged out of itself until the
 * drop had already happened, which is too late to decline it.
 */
let active: SftpDragPayload | null = null

export function beginDrag(payload: SftpDragPayload): SftpDragPayload {
  active = payload
  return payload
}

export function endDrag(): void {
  active = null
}

export function draggedNow(): SftpDragPayload | null {
  return active
}

/**
 * Whether a panel should take what is being dragged over it.
 *
 * Files from the desktop, always. Rows from another host's panel, yes — that is
 * a host-to-host copy. Rows from this same panel, no: the destination is the
 * directory they are already in, so the transfer would be a file onto itself,
 * and the conflict dialog would be asking about every one of them.
 */
export function acceptsDrop(
  types: readonly string[],
  draggedFrom: string | null | undefined,
  panelConnectionId: string | null | undefined
): boolean {
  if (!panelConnectionId) return false
  if (types.includes('Files')) return true
  return types.includes(SFTP_DRAG) && draggedFrom !== panelConnectionId
}
