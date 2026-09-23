/**
 * How far a row in a host tree sits from the edge of the panel.
 *
 * Shared by saved hosts and inventory. A full 22px step makes nested groups
 * distinct, with room for a horizontal branch before each child's icon.
 */
export const TREE_BASE = 4
export const TREE_STEP = 22
/**
 * Hosts have no chevron or title padding. Align their icon with the centre
 * of a subgroup's chevron, leaving the same gap after the branch.
 */
export const TREE_HOST_NUDGE = 34
/**
 * From a folder row's left padding to the middle of its arrow: the title's own
 * six pixels of padding and half of the twelve-pixel chevron. Where the guide
 * line under an open folder falls.
 */
export const GUIDE_OFFSET = 12

export function groupIndent(depth: number): number {
  return TREE_BASE + depth * TREE_STEP
}

export function hostIndent(depth: number): number {
  return groupIndent(depth) + TREE_HOST_NUDGE
}
