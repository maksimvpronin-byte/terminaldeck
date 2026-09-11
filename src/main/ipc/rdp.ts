import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { resolveAuth } from '../../shared/authResolution'
import { applyCredential } from '../../shared/credentials'
import { protocolOf } from '../../shared/protocols'
import { resolveRdp } from '../../shared/rdpResolution'
import type { ResolvedAuth, RdpView, SessionGroup, SessionProfile } from '../../shared/types'
import { splitLogin } from '../../shared/rdpLogin'
import { gitFolderStore } from '../gitFolders/GitFolderStore'
import { inventoryStore } from '../inventory/InventoryStore'
import { type DesktopGateway, type DesktopRequest, freeRdpBridge } from '../rdp/FreeRdpBridge'
import { credentialStore } from '../store/CredentialStore'
import { sessionStore } from '../store/SessionStore'
import { vault } from '../vault/Vault'
import { focusedWin } from './win'

/** Desktop sessions: the gateway and the credentials they resolve. */

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
 * Resolved in the main process and passed directly to FreeRDP.
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
        sound: rdp.sound,
        clipboard: rdp.clipboard
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
}
