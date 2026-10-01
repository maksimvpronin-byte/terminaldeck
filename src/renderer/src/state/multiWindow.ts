import { nanoid } from 'nanoid'
import type { SavedPane } from '../../../shared/types'
import { makeLeaf, type PaneNode } from './paneTree'

/**
 * A tab's panes as a multi-window keeps them, or null when none of them is
 * worth keeping.
 *
 * Everything live is left behind — the connection, the desktop, whether a pane
 * had been restored — and so is a Quick connect pane: it can carry a password
 * typed into it, and names no saved host to open again. A split that loses one
 * half that way is replaced by the half it has left.
 */
export function savedPaneOf(node: PaneNode): SavedPane | null {
  if (node.type === 'leaf') {
    if (node.target.kind !== 'session') return null
    return {
      type: 'leaf',
      sessionId: node.target.sessionId,
      title: node.title,
      ...(node.color ? { color: node.color } : {}),
      ...(node.target.credentialId ? { credentialId: node.target.credentialId } : {}),
      ...(node.target.admin ? { admin: true } : {}),
      ...(node.sftpOpen ? { sftpOpen: true } : {}),
      ...(node.tunnelsOpen ? { tunnelsOpen: true } : {}),
      ...(node.monitorOpen ? { monitorOpen: true } : {})
    }
  }
  const first = savedPaneOf(node.children[0])
  const second = savedPaneOf(node.children[1])
  if (!first || !second) return first ?? second
  return { type: 'split', dir: node.dir, sizes: [...node.sizes], children: [first, second] }
}

/** Panes to open from a multi-window: the same arrangement, every pane new. */
export function paneNodeOf(saved: SavedPane): PaneNode {
  if (saved.type === 'leaf') {
    return {
      ...makeLeaf(
        saved.title,
        {
          kind: 'session',
          sessionId: saved.sessionId,
          ...(saved.credentialId ? { credentialId: saved.credentialId } : {}),
          ...(saved.admin ? { admin: true } : {})
        },
        saved.color
      ),
      sftpOpen: saved.sftpOpen === true,
      tunnelsOpen: saved.tunnelsOpen === true,
      monitorOpen: saved.monitorOpen === true
    }
  }
  return {
    type: 'split',
    id: nanoid(),
    dir: saved.dir,
    sizes: [...saved.sizes],
    children: [paneNodeOf(saved.children[0]), paneNodeOf(saved.children[1])]
  }
}

/** The hosts a multi-window opens, in the order its panes stand. */
export function hostsOf(saved: SavedPane): string[] {
  return saved.type === 'leaf'
    ? [saved.sessionId]
    : [...hostsOf(saved.children[0]), ...hostsOf(saved.children[1])]
}
