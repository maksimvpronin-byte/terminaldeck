import { app, ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
import { IPC } from '../../shared/ipc-channels'
import { resolveAuth } from '../../shared/authResolution'
import { applyCredential } from '../../shared/credentials'
import { protocolOf } from '../../shared/protocols'
import { resolveRdp } from '../../shared/rdpResolution'
import type { ResolvedAuth, RdpView, SessionGroup, SessionProfile } from '../../shared/types'
import { splitLogin } from '../../shared/rdpLogin'
import { qualifyUser } from '../../shared/winSessions'
import { gitFolderStore } from '../gitFolders/GitFolderStore'
import { inventoryStore } from '../inventory/InventoryStore'
import { type DesktopGateway, type DesktopRequest, freeRdpBridge } from '../rdp/FreeRdpBridge'
import { type PaneRect, type ShadowRequest, shadowHostBridge } from '../rdp/ShadowHostBridge'
import { listSessions, shadowSession } from '../rdp/WinSessions'
import { credentialStore } from '../store/CredentialStore'
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
  host: string,
  credentialId?: string
): { username: string; password: string } | undefined {
  if (!profileId) return undefined

  const found = findHost(profileId)
  if (!found) return undefined

  const auth = authFor(found.profile, found.groups, credentialId)
  const password = auth.secretRef ? vault.getSecret(auth.secretRef) : undefined
  if (!auth.username || !password) return undefined

  return { username: qualifyUser(auth.username, host), password }
}

/**
 * A host, wherever it is saved, and the groups its settings inherit along.
 *
 * Hand-made sessions and hosts from a repository resolve identically, and every
 * RDP handler needs both halves, so the lookup lives in one place.
 */
function findHost(
  sessionId: string
): { profile: SessionProfile; groups: SessionGroup[] } | undefined {
  const profile =
    sessionStore.getAll().sessions.find((s) => s.id === sessionId) ??
    inventoryStore.findSession(sessionId) ??
    gitFolderStore.findSession(sessionId)
  if (!profile) return undefined
  return {
    profile,
    groups: [
      ...sessionStore.getAll().groups,
      ...inventoryStore.allGroups(),
      ...gitFolderStore.allGroups()
    ]
  }
}

/**
 * Who a desktop signs in as: the host's resolved login, or a stored account
 * chosen in its place for this session alone.
 *
 * Every desktop handler asks the same question and three of them asked it in
 * their own words, which is how the account would have reached the session and
 * not the gateway, or the session and not the listing of who is logged on.
 *
 * An id that names nothing is refused rather than falling back to the host's
 * own login: signing in as somebody else because the account was deleted is a
 * connection nobody asked for.
 */
function authFor(
  profile: SessionProfile,
  groups: SessionGroup[],
  credentialId?: string
): ResolvedAuth {
  const auth = resolveAuth(profile, profile.groupId, groups)
  if (!credentialId) return auth
  const credential = credentialStore.find(credentialId)
  if (!credential) throw new Error('That saved account no longer exists')
  return applyCredential(auth, credential)
}

/**
 * The gateway for one host, in the form the desktop client takes it.
 *
 * There were two of these until the loopback gateway's handler went: one
 * answering in the shape this application's own gateway wanted, one in the
 * shape the client wants. Only the second has a caller now.
 */
function desktopGateway(
  profile: SessionProfile,
  groups: SessionGroup[],
  /** What the session itself signs in with, account and all. */
  auth: ResolvedAuth
): DesktopGateway | undefined {
  const rdp = resolveRdp(profile, profile.groupId, groups)
  if (!rdp.gatewayHost) return undefined

  // A gateway with no login of its own is given the host's, which is what
  // "use my connection credentials" means in every other client — and when an
  // account was chosen for this session, that account is what the host's login
  // now is, so the gateway is offered it too rather than a login the session
  // itself is not using.
  const secretRef = rdp.gatewayUsername ? rdp.gatewaySecretRef : auth.secretRef
  const login = splitLogin(rdp.gatewayUsername || auth.username || '')

  return {
    host: rdp.gatewayHost,
    port: rdp.gatewayPort,
    // Left unstated when it is the host's own login, so the client sets the
    // "same credentials" flag rather than sending the pair twice.
    username: rdp.gatewayUsername ? login.username : undefined,
    domain: rdp.gatewayUsername ? login.domain : undefined,
    password: rdp.gatewayUsername && secretRef ? (vault.getSecret(secretRef) ?? '') : undefined,
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
        /** A stored account to sign in as instead, for this session alone. */
        credentialId?: string
      }
    ) => {
      const win = focusedWin()
      if (!win) throw new Error('No window to draw into')

      const found = findHost(request.sessionId)
      if (!found) throw new Error('Unknown session')
      if (protocolOf(found.profile) !== 'rdp') throw new Error('That host is not an RDP host')

      const rdp = resolveRdp(found.profile, found.profile.groupId, found.groups)
      const auth = authFor(found.profile, found.groups, request.credentialId)
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
        desktopGateway(found.profile, found.groups, auth)
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
   * Four handlers stood here and are gone with the client that used them.
   *
   * `rdp:reserve` and `rdp:failure` served the loopback gateway the embedded
   * WebAssembly client insisted on dialling; `rdp:tracing` and `rdp:saveLog`
   * carried that client's own logging back out of the window. The desktop is
   * drawn by a separate process now, which signs in itself and keeps its own
   * log in the main process — so nothing asked for any of them, and a door
   * nobody walks through is still a door.
   *
   * This removes the way in, not the gateway. `Gateway.ts`, `TsGateway.ts` and
   * the [MS-TSGU] implementation under them are untouched and still tested;
   * whether to retire them is a decision of its own. See PLAN-freerdp.md.
   */

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
   * Who a host signs in as, and whether it has a password saved — whether, and
   * not what.
   *
   * The pane shows the name and needs to know if it must ask for a password
   * before it can start; those are the only two things the window ever did with
   * the answer. The password itself has no business here: the client
   * authenticates in this process, and a secret that crosses to the window is a
   * secret in a place that cannot keep it.
   */
  ipcMain.handle(IPC.rdpLogin, (_e, sessionId: string, credentialId?: string) => {
    const found = findHost(sessionId)
    if (!found) throw new Error('Unknown session')
    if (protocolOf(found.profile) !== 'rdp') throw new Error('That host is not an RDP host')

    const auth = authFor(found.profile, found.groups, credentialId)
    return {
      username: auth.username,
      hasPassword: Boolean(auth.secretRef && vault.getSecret(auth.secretRef))
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
    return shadowHostBridge.start(
      win,
      request,
      shadowCredentials(request.profileId, request.host, request.credentialId)
    )
  })
  ipcMain.on(IPC.shadowPlace, (_e, id: string, rect: PaneRect) => shadowHostBridge.place(id, rect))
  ipcMain.on(IPC.shadowVisible, (_e, id: string, visible: boolean) =>
    shadowHostBridge.setVisible(id, visible)
  )
  ipcMain.handle(IPC.shadowStop, (_e, id: string) => shadowHostBridge.stop(id))

  ipcMain.handle(IPC.rdpListSessions, (_e, sessionId: string, credentialId?: string) => {
    const found = findHost(sessionId)
    if (!found) throw new Error('Unknown session')

    // Asked as whoever this pane is connecting as: a host outside this
    // machine's domain answers the query for one account and refuses it for
    // another, and the pane offering to join a session it cannot reach is a
    // worse answer than an empty list.
    const auth = authFor(found.profile, found.groups, credentialId)
    const password = auth.secretRef ? vault.getSecret(auth.secretRef) : undefined
    return listSessions(
      found.profile.host,
      password ? { username: auth.username, password } : undefined
    )
  })
  ipcMain.handle(
    IPC.rdpShadow,
    (_e, host: string, sessionId: number, options: { control: boolean; skipPrompt: boolean }) =>
      shadowSession(host, sessionId, options)
  )
}
