import { inheritanceChain } from './inheritance'
import { isSet } from './overrides'
import type { RdpDefaults, ResolvedRdp, SessionGroup } from './types'

/**
 * What a desktop falls back to when nothing in the chain states anything.
 *
 * No gateway, because the app has always dialled hosts directly and a gateway
 * that appeared by default would route traffic somewhere nobody asked for. The
 * size is the one an unstated `.rdp` file ends up at, and only applies in
 * `fixed` mode.
 *
 * The pixel budget is generous enough that an ordinary screen is never capped
 * by it — a 2560×1440 window is 3.7 megapixels only when every point is already
 * a pixel, and there the budget cannot apply anyway — and tight enough that a
 * Retina pane is sharpened rather than quadrupled.
 */
export const RDP_FALLBACK: ResolvedRdp = {
  gatewayPort: 443,
  gatewayBypassLocal: false,
  // As every Windows client does. Sound arrives over its own channel and is
  // played by the desktop client's process, so nothing about it crosses into
  // the window.
  sound: true,
  resolution: 'fit',
  desktopWidth: 1920,
  desktopHeight: 1080,
  pixelBudget: 3.5,
  // Follow whatever display the window is on, which draws a desktop the size an
  // ordinary monitor would give it whatever the density is.
  magnification: 0,
  // The far end lays itself out as it always has unless a host asks otherwise.
  sendDensity: false,
  commandAsControl: false
}

const optedOut = (level: RdpDefaults): boolean => level.inheritRdp === false

export function rdpChain(
  own: RdpDefaults,
  groupId: string | null,
  groups: SessionGroup[]
): RdpDefaults[] {
  return inheritanceChain(own, groupId, groups, optedOut)
}

function pick<K extends keyof RdpDefaults>(
  chain: RdpDefaults[],
  key: K
): RdpDefaults[K] | undefined {
  // Empty strings count as "not set", so a blank field in the UI inherits.
  for (const level of chain) {
    if (isSet(level[key])) return level[key]
  }
  return undefined
}

function firstDefined<K extends keyof RdpDefaults>(
  chain: RdpDefaults[],
  key: K
): RdpDefaults[K] | undefined {
  for (const level of chain) {
    if (level[key] !== undefined) return level[key]
  }
  return undefined
}

export function resolveRdp(
  own: RdpDefaults,
  groupId: string | null,
  groups: SessionGroup[]
): ResolvedRdp {
  const chain = rdpChain(own, groupId, groups)
  /**
   * The gateway login travels with the gateway that states it. Picking the two
   * independently would let a host inherit one gateway's address and another's
   * password — which fails as a wrong password, giving no hint that two levels
   * were mixed.
   */
  const gatewayLevel = chain.find((level) => isSet(level.gatewayHost))
  return {
    gatewayHost: gatewayLevel?.gatewayHost,
    gatewayPort: gatewayLevel?.gatewayPort ?? RDP_FALLBACK.gatewayPort,
    gatewayUsername: gatewayLevel?.gatewayUsername,
    gatewaySecretRef: gatewayLevel?.gatewaySecretRef,
    gatewayBypassLocal: gatewayLevel?.gatewayBypassLocal ?? RDP_FALLBACK.gatewayBypassLocal,
    resolution: pick(chain, 'resolution') ?? RDP_FALLBACK.resolution,
    desktopWidth: pick(chain, 'desktopWidth') ?? RDP_FALLBACK.desktopWidth,
    desktopHeight: pick(chain, 'desktopHeight') ?? RDP_FALLBACK.desktopHeight,
    pixelBudget: pick(chain, 'pixelBudget') ?? RDP_FALLBACK.pixelBudget,
    // Zero is a stated value here — "follow the display" — so this reads the
    // first level that says anything at all, blank included.
    magnification: pick(chain, 'magnification') ?? RDP_FALLBACK.magnification,
    // Booleans can be legitimately false, so they take the first explicit value.
    sound: firstDefined(chain, 'sound') ?? RDP_FALLBACK.sound,
    sendDensity: firstDefined(chain, 'sendDensity') ?? RDP_FALLBACK.sendDensity,
    commandAsControl: firstDefined(chain, 'commandAsControl') ?? RDP_FALLBACK.commandAsControl
  }
}

/**
 * Where an effective value came from, so the dialog can show what a blank field
 * will actually use. Undefined when the value is the host's own.
 */
export function rdpInheritedFrom(
  own: RdpDefaults,
  groupId: string | null,
  groups: SessionGroup[],
  key: keyof RdpDefaults
): SessionGroup | undefined {
  if (isSet(own[key])) return undefined
  // Skip the item itself; everything after it in the chain is an ancestor group.
  for (const level of rdpChain(own, groupId, groups).slice(1)) {
    if (isSet(level[key])) return level as SessionGroup
  }
  return undefined
}
