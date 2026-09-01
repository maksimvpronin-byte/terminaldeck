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
/**
 * Whether one destination may be written.
 *
 * The third argument is the whole point. Without it this could not tell a
 * destination nobody objected to from one that raised a conflict whose answer
 * went missing, and it treated both as permission to overwrite — while
 * `defaultDecisions` above fills every conflict with `skip` and says in a
 * comment that skipping is the default, and the dialog shows `skip` for
 * anything undecided. Three places, two answers, and the one that ran was the
 * destructive one.
 *
 * So: an explicit answer is obeyed. Silence means write, unless the path was
 * named as a conflict — and then it means leave it alone, which is what the
 * other two already claimed.
 */
export function shouldWrite(
  destPath: string,
  decisions: TransferDecisions,
  conflicted: ReadonlySet<string> = new Set()
): boolean {
  const decided = decisions[destPath]
  if (decided) return decided !== 'skip'
  return !conflicted.has(destPath)
}

/** The destinations a plan says something already occupies. */
export function conflictedPaths(plan: TransferPlan): ReadonlySet<string> {
  return new Set(plan.conflicts.map((c) => c.destPath))
}
