/**
 * How far a row in a host tree sits from the edge of the panel.
 *
 * Written down once because both trees draw it and they must agree, and because
 * the old numbers — a base of 8, a step of 12 and a whole extra step for a host
 * — compounded faster than they looked. Three levels down, a name started
 * 58px into a 260px panel and there was nothing left to read it in: the
 * screenshot that prompted this had every host truncated to `k8s2-mstr…`.
 *
 * A host is nudged inside its group rather than given a level of its own. It
 * has no chevron to make room for, so the icon in front of its name lands under
 * the folder above it, which is what says "inside" — a full step said it twice.
 */
export const TREE_BASE = 4
export const TREE_STEP = 10
/** What a host adds to its group's indent. Less than a step, on purpose. */
export const TREE_HOST_NUDGE = 8

export function groupIndent(depth: number): number {
  return TREE_BASE + depth * TREE_STEP
}

export function hostIndent(depth: number): number {
  return groupIndent(depth) + TREE_HOST_NUDGE
}
