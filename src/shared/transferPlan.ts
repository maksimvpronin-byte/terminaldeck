import type {
  ConflictReason,
  TransferConflict,
  TransferDecisions,
  TransferDirection,
  TransferItem,
  TransferPlan
} from './types'

/** What already sits at a destination, from either side of the connection. */
export interface DestInfo {
  size: number
  mtime: number
  isDirectory: boolean
  isSymlink: boolean
  /** Stat failed for a reason other than "not there" — permissions, usually. */
  unreadable?: boolean
}

function reasonFor(info: DestInfo): ConflictReason {
  if (info.unreadable) return 'unreadable'
  if (info.isDirectory) return 'directory'
  if (info.isSymlink) return 'symlink'
  return 'file'
}

/**
 * Works out what a transfer would trample before a single byte moves.
 *
 * Deciding up front rather than prompting mid-copy is the whole point: a
 * question that arrives after 200 MB are already on the wire is asked too late
 * to be answered well, and half the batch is done either way.
 *
 * Pure on purpose — the two sides supply their own `lookup`, and this file is
 * where the rules live for both directions.
 */
export function buildTransferPlan(
  direction: TransferDirection,
  items: TransferItem[],
  lookup: (destPath: string) => DestInfo | null
): TransferPlan {
  const conflicts: TransferConflict[] = []
  const sourcesByDest = new Map<string, string[]>()

  for (const item of items) {
    const sharing = sourcesByDest.get(item.destPath) ?? []
    sharing.push(item.sourcePath)
    sourcesByDest.set(item.destPath, sharing)

    const info = lookup(item.destPath)
    if (!info) continue
    conflicts.push({
      ...item,
      destSize: info.size,
      destMtime: info.mtime,
      reason: reasonFor(info)
    })
  }

  // Two local files can map to one remote name when the local filesystem is
  // case-insensitive and the remote one is not. Merging them silently would
  // mean one overwrites the other with no conflict ever reported.
  const collisions = [...sourcesByDest.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([destPath, sourcePaths]) => ({ destPath, sourcePaths }))

  return {
    direction,
    items,
    conflicts,
    collisions,
    totalBytes: items.reduce((sum, item) => sum + item.sourceSize, 0)
  }
}

/** True when this destination may only ever be skipped, never replaced. */
export function isRefusable(reason: ConflictReason): boolean {
  return reason !== 'file'
}

/**
 * Decisions with every unreplaceable conflict already set to skip, so a dialog
 * cannot offer — and a transfer cannot act on — an overwrite that would fail or
 * destroy a directory.
 */
export function defaultDecisions(plan: TransferPlan): TransferDecisions {
  const decisions: TransferDecisions = {}
  for (const conflict of plan.conflicts) {
    // Skip is the default for everything: a stray Enter must not overwrite.
    decisions[conflict.destPath] = 'skip'
  }
  return decisions
}

/** Whether a given file should be written, given the answers collected. */
export function shouldWrite(destPath: string, decisions: TransferDecisions): boolean {
  return decisions[destPath] !== 'skip'
}
