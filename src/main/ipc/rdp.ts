import { app, ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
import { IPC } from '../../shared/ipc-channels'
import { resolveAuth } from '../../shared/authResolution'
import { protocolOf } from '../../shared/protocols'
import { resolveRdp } from '../../shared/rdpResolution'
import type { RdpView, SessionGroup, SessionProfile } from '../../shared/types'
import { splitLogin } from '../../shared/rdpLogin'
import { qualifyUser } from '../../shared/winSessions'
import { inventoryStore } from '../inventory/InventoryStore'
import { type RdpRoute, rdpGateway } from '../rdp/Gateway'
import {
  type DesktopGateway,
  type DesktopRequest,
  freeRdpBridge
} from '../rdp/FreeRdpBridge'
import { type PaneRect, type ShadowRequest, shadowHostBridge } from '../rdp/ShadowHostBridge'
import { listSessions, shadowSession } from '../rdp/WinSessions'
import { sessionStore } from '../store/SessionStore'
import { vault } from '../vault/Vault'
import { focusedWin } from './win'

/** Desktop sessions: the gateway, the credentials they resolve, and shadowing. */

/**
 * The host's credentials for the shadow viewer, if the vault holds any.
 *
 * `mstsc` carries none of its own: shadowing authenticates over RPC with the
 * identity of whoever started it, so a viewer started as the signed-in Windows
 * user is refused by any host that does not know that account. The account name
 * is qualified with the host for the same reason the session listing qualifies
 * it — a bare name means this machine's domain, not the target's.
 */
function shadowCredentials(
  profileId: string | undefined,
  host: string
): { username: string; password: string } | undefined {
  if (!profileId) return undefined

  const profile =
    sessionStore.getAll().sessions.find((s) => s.id === profileId) ??
    inventoryStore.findSession(profileId)
  if (!profile) return undefined

  const groups = [...sessionStore.getAll().groups, ...inventoryStore.allGroups()]
  const auth = resolveAuth(profile, profile.groupId, groups)
  const password = auth.secretRef ? vault.getSecret(auth.secretRef) : undefined
  if (!auth.username || !password) return undefined

  return { username: qualifyUser(auth.username, host), password }
}

/**
 * A host, wherever it is saved, and the groups its settings inherit along.
 *
 * Hand-made sessions and inventory hosts resolve identically, and every RDP
 * handler needs both halves, so the lookup lives in one place.
 */
function findHost(
  sessionId: string
): { profile: SessionProfile; groups: SessionGroup[] } | undefined {
  const profile =
    sessionStore.getAll().sessions.find((s) => s.id === sessionId) ??
    inventoryStore.findSession(sessionId)
  if (!profile) return undefined
  return { profile, groups: [...sessionStore.getAll().groups, ...inventoryStore.allGroups()] }
}

/**
 * How one host is to be reached, gateway password included.
 *
 * Resolved here and kept here. The window is handed a loopback address and
 * nothing else, so a gateway credential — unlike the host's own, which CredSSP
 * forces into the renderer — never leaves the main process at all.
 */
function routeFor(sessionId: string | undefined): RdpRoute {
  if (!sessionId) return {}
  const found = findHost(sessionId)
  if (!found) return {}

  const rdp = resolveRdp(found.profile, found.profile.groupId, found.groups)
  if (!rdp.gatewayHost) return {}

  // A gateway with no login of its own is given the host's, which is what
  // "use my connection credentials" means in every other client.
  const auth = resolveAuth(found.profile, found.profile.groupId, found.groups)
  const username = rdp.gatewayUsername || auth.username
  const secretRef = rdp.gatewayUsername ? rdp.gatewaySecretRef : auth.secretRef

  return {
    gateway: {
      host: rdp.gatewayHost,
      port: rdp.gatewayPort,
      username,
      password: secretRef ? vault.getSecret(secretRef) ?? '' : '',
      bypassLocal: rdp.gatewayBypassLocal
    }
  }
}

/**
 * The gateway for one host, in the form the desktop client takes it.
 *
 * The same resolution `routeFor` does for the old path, kept beside it rather
 * than shared: that one returns the shape this app's own gateway wants, and
 * folding two callers into one function that answers both would be a function
 * whose return value has to be read twice to know what it means.
 */
function desktopGateway(profile: SessionProfile, groups: SessionGroup[]): DesktopGateway | undefined {
  const rdp = resolveRdp(profile, profile.groupId, groups)
  if (!rdp.gatewayHost) return undefined

  // A gateway with no login of its own is given the host's, which is what
  // "use my connection credentials" means in every other client.
  const auth = resolveAuth(profile, profile.groupId, groups)
  const secretRef = rdp.gatewayUsername ? rdp.gatewaySecretRef : auth.secretRef
  const login = splitLogin(rdp.gatewayUsername || auth.username || '')

  return {
    host: rdp.gatewayHost,
    port: rdp.gatewayPort,
    // Left unstated when it is the host's own login, so the client sets the
    // "same credentials" flag rather than sending the pair twice.
    username: rdp.gatewayUsername ? login.username : undefined,
    domain: rdp.gatewayUsername ? login.domain : undefined,
    password: rdp.gatewayUsername && secretRef ? vault.getSecret(secretRef) ?? '' : undefined,
    bypassLocal: rdp.gatewayBypassLocal
  }
}

export function registerRdpHandlers(): void {
  /**
   * Opens a desktop, drawn by td-rdp in a process of its own.
   *
   * Everything about *where* and *as whom* is resolved here and goes straight
   * down a pipe. That is the difference the new client makes and it is worth
   * stating plainly: the one it replaced signed in inside the window, so this
   * app had to hand a stored password to the renderer to use RDP at all. It no
   * longer does. The window names a host and is given an id.
   *
   * A password typed into the pane is still accepted, for the hosts that have
   * none saved — it came from a person at the keyboard rather than the vault,
   * and refusing it would only mean refusing to connect.
   */
  ipcMain.handle(
    IPC.desktopStart,
    (
      _e,
      request: {
        sessionId: string
        width: number
        height: number
        scale?: number
        password?: string
      }
    ) => {
      const win = focusedWin()
      if (!win) throw new Error('No window to draw into')

      const found = findHost(request.sessionId)
      if (!found) throw new Error('Unknown session')
      if (protocolOf(found.profile) !== 'rdp') throw new Error('That host is not an RDP host')

      const rdp = resolveRdp(found.profile, found.profile.groupId, found.groups)
      const auth = resolveAuth(found.profile, found.profile.groupId, found.groups)
      const login = splitLogin(auth.username ?? '')
      const stored = auth.secretRef ? vault.getSecret(auth.secretRef) : undefined

      const desktop: DesktopRequest = {
        host: found.profile.host,
        port: found.profile.port,
        width: request.width,
        height: request.height,
        scale: rdp.sendDensity ? request.scale : undefined,
        sound: rdp.sound
      }

      return freeRdpBridge.start(
        win,
        desktop,
        {
          username: login.username,
          domain: login.domain,
          // What the vault holds, or what was typed when it holds nothing.
          password: stored ?? request.password ?? ''
        },
        desktopGateway(found.profile, found.groups)
      )
    }
  )

  // Input, a new size, and the acknowledgement of a frame. `on` rather than
  // `handle`: a mouse moving is sixty of these a second, and none of them has
  // an answer worth waiting for.
  ipcMain.on(
    IPC.desktopSend,
    (_e, id: string, fields: Record<string, string | number | boolean | undefined>) =>
      freeRdpBridge.send(id, fields)
  )
  ipcMain.handle(IPC.desktopStop, (_e, id: string) => freeRdpBridge.stop(id))

  /**
   * The desktop client's own log, written beside the session logs.
   *
   * Kept in the main process as it arrives and written only when asked for,
   * which is the lesson the last client taught the hard way: forwarding it live
   * to a console took the renderer to four gigabytes inside a minute.
   */
  ipcMain.handle(IPC.desktopLog, async (_e, id: string) => {
    const dir = join(app.getPath('userData'), 'logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const target = join(dir, `desktop-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
    await writeFile(target, freeRdpBridge.logFor(id).join('\n'), 'utf8')
    return target
  })

  // --- Graphical sessions ---
  /**
   * Reserves a single-use loopback address, and settles behind it how the
   * session will actually be routed. Takes a host id rather than a route so the
   * gateway and its password are resolved here; see routeFor.
   */
  ipcMain.handle(IPC.rdpReserve, (_e, sessionId?: string) =>
    rdpGateway.reserve(routeFor(sessionId))
  )

  /**
   * What level the desktop client should log at, or nothing to leave it quiet.
   *
   * Asked for by hand only. It used to be on for every `npm run dev`, and that
   * is not a safe default: the client logs several lines per frame, the console
   * holds each one with its arguments, and a live desktop took the renderer to
   * four gigabytes and an out-of-memory crash inside a minute. What it says
   * about codecs and channels is worth having, in the seconds it takes to read
   * it — not for the length of a working session.
   *
   * `=1` means `debug`, which is everything. Any other value is handed over as
   * it stands, in case the client understands a filter — 0.11 did not, and went
   * silent when given one, so narrowing the question means a short session
   * rather than a narrow filter.
   */
  ipcMain.handle(IPC.rdpTracing, () => {
    const asked = process.env.TERMINALDECK_RDP_TRACE
    if (!asked) return null
    return asked === '1' ? 'debug' : asked
  })

  /**
   * Keeps what the client said, out of the window that cannot hold it.
   *
   * The renderer catches the first lines and drops the rest; this puts them
   * beside the session logs, where a path can be pasted into an issue.
   */
  ipcMain.handle(IPC.rdpSaveLog, async (_e, lines: string[]) => {
    const dir = join(app.getPath('userData'), 'logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const target = join(dir, `rdp-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
    await writeFile(target, lines.join('\n'), 'utf8')
    return target
  })

  ipcMain.handle(IPC.rdpFailure, (_e, proxyAddress: string) =>
    rdpGateway.failureFor(proxyAddress)
  )

  /**
   * The desktop settings for one host: how big it should be, and how the
   * keyboard behaves. Everything the window legitimately needs to draw a
   * session, and deliberately nothing about where that session is routed.
   */
  ipcMain.handle(IPC.rdpSettings, (_e, sessionId: string) => {
    const found = findHost(sessionId)
    if (!found) throw new Error('Unknown session')
    const rdp = resolveRdp(found.profile, found.profile.groupId, found.groups)
    const view: RdpView = {
      resolution: rdp.resolution,
      desktopWidth: rdp.desktopWidth,
      desktopHeight: rdp.desktopHeight,
      pixelBudget: rdp.pixelBudget,
      magnification: rdp.magnification,
      sendDensity: rdp.sendDensity,
      commandAsControl: rdp.commandAsControl
    }
    return view
  })

  /**
   * The login for one host, resolved through the same inheritance chain SSH
   * uses, so a group can state it once.
   *
   * This is the only place a stored secret leaves the main process, and it is
   * deliberately narrow: it answers for one named host and returns nothing else,
   * so the window cannot walk the vault. It exists because an RDP client
   * authenticates where it draws — CredSSP happens in the WebAssembly module —
   * and there is no way to do that from here without implementing CredSSP too.
   */
  ipcMain.handle(IPC.rdpCredentials, (_e, sessionId: string) => {
    const profile =
      sessionStore.getAll().sessions.find((s) => s.id === sessionId) ??
      inventoryStore.findSession(sessionId)
    if (!profile) throw new Error('Unknown session')
    if (protocolOf(profile) !== 'rdp') throw new Error('That host is not an RDP host')

    const groups = [...sessionStore.getAll().groups, ...inventoryStore.allGroups()]
    const auth = resolveAuth(profile, profile.groupId, groups)
    return {
      username: auth.username,
      // Empty rather than absent when nothing is stored: the window then asks,
      // which is also the path for people who deliberately save no password.
      password: auth.secretRef ? vault.getSecret(auth.secretRef) ?? '' : ''
    }
  })

  /**
   * Takes a host id rather than an address so the credentials can be resolved
   * here: the query signs in as the Windows account running this app, which is
   * the wrong one for any host outside its domain, and the right one is already
   * in the vault. The password is used and dropped without reaching the window.
   */
  ipcMain.handle(IPC.shadowStart, (_e, request: ShadowRequest) => {
    const win = focusedWin()
    if (!win) throw new Error('No window to draw into')
    return shadowHostBridge.start(win, request, shadowCredentials(request.profileId, request.host))
  })
  ipcMain.on(IPC.shadowPlace, (_e, id: string, rect: PaneRect) =>
    shadowHostBridge.place(id, rect)
  )
  ipcMain.on(IPC.shadowVisible, (_e, id: string, visible: boolean) =>
    shadowHostBridge.setVisible(id, visible)
  )
  ipcMain.handle(IPC.shadowStop, (_e, id: string) => shadowHostBridge.stop(id))

  ipcMain.handle(IPC.rdpListSessions, (_e, sessionId: string) => {
    const profile =
      sessionStore.getAll().sessions.find((s) => s.id === sessionId) ??
      inventoryStore.findSession(sessionId)
    if (!profile) throw new Error('Unknown session')

    const groups = [...sessionStore.getAll().groups, ...inventoryStore.allGroups()]
    const auth = resolveAuth(profile, profile.groupId, groups)
    const password = auth.secretRef ? vault.getSecret(auth.secretRef) : undefined
    return listSessions(
      profile.host,
      password ? { username: auth.username, password } : undefined
    )
  })
  ipcMain.handle(
    IPC.rdpShadow,
    (_e, host: string, sessionId: number, options: { control: boolean; skipPrompt: boolean }) =>
      shadowSession(host, sessionId, options)
  )

}
