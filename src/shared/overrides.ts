import { protocolOf, type Protocol } from './protocols'

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
  return layerOver(node, patch)
}

/**
 * `patch` over `node`, by the rules of an override: blanks shadow nothing, and
 * a switched protocol takes the node's port with it. The editing dialog lays
 * its form over an inventory host with this as well, so what it says a host
 * will connect on is what the connection uses.
 */
export function layerOver<T extends object>(node: T, patch: object): T {
  const merged: T = { ...node, ...withoutBlanks(patch) }
  /*
   * A repository's port belongs to the protocol the repository named. A host
   * the inventory calls SSH carries its ansible_port — WinRM's 5985 on a
   * Windows box — and switched to RDP here it went on dialling that port for a
   * desktop; a desktop's terminaldeck_port did the same the other way. Unless
   * the override states a port of its own, a switched host drops the one it
   * came with and takes its new protocol's default.
   */
  const stated = patch as { protocol?: Protocol; port?: unknown }
  const switched =
    isSet(stated.protocol) && protocolOf(stated) !== protocolOf(node as { protocol?: Protocol })
  if (switched && !isSet(stated.port)) delete (merged as { port?: unknown }).port
  return merged
}
