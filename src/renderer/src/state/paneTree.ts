import { nanoid } from 'nanoid'
import type { QuickConnectParams } from '../../../shared/types'

export type PaneTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'quick'; params: QuickConnectParams }

export type PaneNode =
  | {
      type: 'leaf'
      id: string
      title: string
      target: PaneTarget
      /** Copied from the session profile so tabs and panes can be tinted. */
      color?: string
      connectionId?: string
      /** Came back from a saved layout: show it idle instead of dialling out on launch. */
      restored?: boolean
      sftpOpen: boolean
      tunnelsOpen: boolean
      /** Whether this terminal takes part in broadcast input. */
      broadcastEnabled: boolean
      /**
       * The collection this pane was opened from, when it was. A host may sit in
       * several, so which one lends its look cannot be answered by the host
       * alone — it is answered by where you opened it.
       */
      viaCollectionId?: string
    }
  | {
      type: 'split'
      id: string
      dir: 'row' | 'col'
      children: [PaneNode, PaneNode]
      sizes: [number, number]
    }

export type LeafNode = Extract<PaneNode, { type: 'leaf' }>

export function makeLeaf(
  title: string,
  target: PaneTarget,
  color?: string,
  viaCollectionId?: string
): LeafNode {
  return {
    type: 'leaf',
    id: nanoid(),
    connectionId: undefined,
    title,
    target,
    color,
    viaCollectionId,
    sftpOpen: false,
    tunnelsOpen: false,
    broadcastEnabled: true
  }
}

export function mapPane(node: PaneNode, id: string, fn: (leaf: LeafNode) => LeafNode): PaneNode {
  if (node.type === 'leaf') return node.id === id ? fn(node) : node
  if (node.id === id) return node
  return {
    ...node,
    children: [mapPane(node.children[0], id, fn), mapPane(node.children[1], id, fn)]
  }
}

export function findPane(node: PaneNode | null, id: string): PaneNode | undefined {
  if (!node) return undefined
  if (node.id === id) return node
  if (node.type === 'split') {
    return findPane(node.children[0], id) ?? findPane(node.children[1], id)
  }
  return undefined
}

export function replacePane(node: PaneNode, id: string, replacement: PaneNode): PaneNode {
  if (node.id === id) return replacement
  if (node.type === 'split') {
    return {
      ...node,
      children: [
        replacePane(node.children[0], id, replacement),
        replacePane(node.children[1], id, replacement)
      ]
    }
  }
  return node
}

/** Drops a leaf from the tree; the surviving sibling takes the split's place. */
export function removePane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === 'leaf') return node.id === paneId ? null : node
  const a = removePane(node.children[0], paneId)
  const b = removePane(node.children[1], paneId)
  if (a === null) return b
  if (b === null) return a
  return { ...node, children: [a, b] }
}

export function setSizes(node: PaneNode, id: string, sizes: [number, number]): PaneNode {
  if (node.type === 'split') {
    if (node.id === id) return { ...node, sizes }
    return {
      ...node,
      children: [setSizes(node.children[0], id, sizes), setSizes(node.children[1], id, sizes)]
    }
  }
  return node
}

export function splitLeaf(
  root: PaneNode,
  paneId: string,
  dir: 'row' | 'col',
  position: 'before' | 'after',
  newLeaf: LeafNode
): PaneNode | null {
  const source = findPane(root, paneId)
  if (!source || source.type !== 'leaf') return null
  const children: [PaneNode, PaneNode] =
    position === 'before' ? [newLeaf, source] : [source, newLeaf]
  const splitNode: PaneNode = { type: 'split', id: nanoid(), dir, children, sizes: [50, 50] }
  return replacePane(root, paneId, splitNode)
}

/** Connection ids of every connected pane in a tab. */
export function collectConnectionIds(node: PaneNode): string[] {
  if (node.type === 'leaf') return node.connectionId ? [node.connectionId] : []
  return [...collectConnectionIds(node.children[0]), ...collectConnectionIds(node.children[1])]
}

/** Connection ids of panes opted in to broadcast. */
export function collectBroadcastTargets(node: PaneNode): string[] {
  if (node.type === 'leaf') {
    return node.connectionId && node.broadcastEnabled ? [node.connectionId] : []
  }
  return [
    ...collectBroadcastTargets(node.children[0]),
    ...collectBroadcastTargets(node.children[1])
  ]
}

/** Every leaf in a tab, regardless of connection state. */
export function collectLeaves(node: PaneNode): LeafNode[] {
  if (node.type === 'leaf') return [node]
  return [...collectLeaves(node.children[0]), ...collectLeaves(node.children[1])]
}

/** Session ids that currently have a live terminal somewhere. */
export function collectConnectedSessionIds(node: PaneNode): string[] {
  if (node.type === 'leaf') {
    return node.connectionId && node.target.kind === 'session' ? [node.target.sessionId] : []
  }
  return [
    ...collectConnectedSessionIds(node.children[0]),
    ...collectConnectedSessionIds(node.children[1])
  ]
}

export function setAllBroadcast(node: PaneNode, enabled: boolean): PaneNode {
  return node.type === 'leaf'
    ? { ...node, broadcastEnabled: enabled }
    : {
        ...node,
        children: [
          setAllBroadcast(node.children[0], enabled),
          setAllBroadcast(node.children[1], enabled)
        ]
      }
}
