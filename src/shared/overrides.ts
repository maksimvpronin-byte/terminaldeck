/**
 * A blank field means "not set" everywhere in the app: leaving a form field
 * empty hands the value back to whatever is above it rather than storing an
 * empty string.
 */
export function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

/** The same object without its blank fields, so it only shadows what it states. */
export function withoutBlanks<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => isSet(v))) as Partial<T>
}

/**
 * Layers local settings over a node derived from a repository.
 *
 * Both the main process, when resolving what to connect with, and the renderer,
 * when showing what a host will do, must agree here — a divergence would show
 * one thing and connect with another.
 */
export function applyOverride<T extends object, O extends { nodeId: string }>(
  node: T,
  override: O | undefined
): T {
  if (!override) return node
  const { nodeId: _addressed, ...patch } = override
  return { ...node, ...withoutBlanks(patch) }
}
