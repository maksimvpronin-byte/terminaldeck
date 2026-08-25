# Changelog

The version in `package.json` is the one the app reports and the one
`electron-updater` compares against. A `v*` tag matching it is what actually
publishes a release — see [Releasing](README.md#releasing). Bumping one without
the other produces a version nobody can install, which is how 0.1.10 through
0.3.2 came to be written and never released: no tag, so no build ever ran.

## Unreleased

### Added

- **A Russian interface**, chosen in Settings and applied at once. The English
  text is the key, so a screen with no translation yet shows English rather than
  machine names — a working screen, and visibly an untranslated one. Settings,
  the shortcut and feature list, the session tree, the tab strip, the pane
  toolbar, the session dialog and everything a desktop session shows are
  translated; the file browser, the inventory dialogs and the smaller panels are
  not yet.

- **Desktop settings on a host, a group and an inventory override**: the RD
  Gateway to reach a machine through, the resolution, and whether ⌘ is sent as
  Ctrl. They inherit along the same chain the login does, so a shared gateway is
  stated once on the group. The gateway's own password is resolved in the main
  process and never crosses into the window.
- **A desktop can actually be resized now.** [MS-RDPEDISP] travels on a dynamic
  virtual channel that has to be asked for while the session is built, and it
  never was — so `resize` had nowhere to send its request and silently did
  nothing. Every session kept the size it started with and the pane stretched
  that picture to fill itself, which looked like a desktop drawn too large and
  slightly soft rather than like a missing feature. The session now also starts
  at the right size, so the first frame is already correct.
- **A desktop's size follows the screen rather than the pane**, with a pixel
  budget the host can set. A pane is measured in points and a Retina screen has
  four pixels for each of them, so asking for the points produced a small
  desktop that the screen magnified — soft, and everything in it oversized.
  Past the budget the size lands between the two rather than at the largest,
  and on a screen with one pixel per point nothing changes at all. Moving the
  window to a display of another density re-negotiates the size, which a change
  of pane size alone would not.
- **Fixed resolution** as an alternative to following the pane: the desktop
  keeps a stated size and is scaled into the pane instead of resizing the far
  end on every drag.
- **⌘ as Ctrl**, per host and off by default, so copy and paste land where they
  do on Windows. The client maps `KeyboardEvent.code` through a fixed table and
  cannot be told to swap the two, so the events are rewritten before they reach
  it — including the key release macOS withholds while ⌘ is held, which would
  otherwise leave a key stuck down on the far side.
- **Sessions are carried through the gateway** — [MS-TSGU] spoken here rather
  than delegated to anything: the HTTPS request to `/remoteDesktopGateway/` and
  its WebSocket upgrade, an NTLMv2 sign-in in the headers of that request, then
  the handshake that opens a tunnel and a channel. What comes out is an ordinary
  duplex stream, so the X.224 exchange and the TLS handshake above it are
  untouched and do not know they are in a tunnel.
- The gateway sign-in is **bound to the connection** with `tls-server-end-point`,
  or a gateway with Extended Protection refuses it exactly as it refuses a wrong
  password.
- Every gateway request now carries an **`RDG-Correlation-Id`**, which the
  reference client always sends and this one did not. It is what a gateway files
  its own logging under, and a request without it is not the request a Windows
  client makes.
- A gateway that drops the connection after accepting the password is retried
  with **each shape of authenticate message** — with and without the service
  name, with the terminal-service form of it, and unsigned — in one run of about
  a second. A search rather than a diagnosis, and a small one: Extended
  Protection is a server setting with several positions and every one of them
  refuses identically, with nothing visible from outside. If all of them are
  dropped, the message says so, because at that point the setting is at the
  other end.
- The gateway sign-in now names **the service it is for** as well as the
  connection it arrived over. Extended Protection has two halves — channel
  binding and service binding — and a gateway that requires the second accepts
  the message as well formed, checks the password, and only then refuses. Which
  is why its absence is invisible for as long as the password is wrong.
- A gateway that drops the connection on both transports is **retried over TLS
  1.2**. Windows binds HTTP authentication to the connection it arrived on, and
  its HTTP stack has never handled that reliably over TLS 1.3 — the failure it
  produces has a shape, and this is it: everything works until the moment the
  sign-in succeeds, which is when the connection becomes an authenticated one.
  Only the gateway's TLS is capped, and only after both transports have failed.
- **The older gateway transport**, for a gateway that cannot upgrade to a
  WebSocket. Two connections sharing one connection id, every packet wrapped as
  an HTTP chunk, and the short run of random bytes [MS-TSGU] has the gateway
  send first dropped rather than read as a packet. The WebSocket transport is
  still tried first and the fallback is automatic, because a gateway that lacks
  it says nothing — it accepts the sign-in and then drops the connection.
- A dropped gateway connection now **names the connection as well as the step**
  — the older transport has two, and a reset that does not say which is as good
  as silent. The older transport's failure also leads the report, because a
  refused WebSocket upgrade is ordinary: Microsoft's own client fails it against
  such a gateway and falls back without complaint.
- A dropped gateway connection now **names the step it was waiting on** — the
  challenge, or the answer to the sign-in — because `ECONNRESET` alone covers a
  rejected message, a blocked account and a network in the way, and which
  request it landed on is most of what separates them.
- NTLM **checks its own primitives once** against the worked example in
  [MS-NLMP] before signing in. MD4 and RC4 are implemented here and HMAC-MD5
  comes from the runtime; a build where any of them differs produces messages a
  gateway rejects without ever saying why, and a unit test proves nothing about
  the runtime the app ships on.
- A gateway sign-in that is **reset rather than answered** is diagnosed instead
  of reported as `ECONNRESET`: the sign-in is retried once without the upgrade,
  which separates "the credentials were refused" from "the gateway does not
  speak the WebSocket transport". The two need completely different answers and
  look identical otherwise.
- **A failed desktop session says what went wrong.** The client reports almost
  everything as "General failure", and reports "not enough bytes" when this
  app's own proxy closed the socket — so the reason, which only ever exists in
  the main process, is now kept and shown in the pane instead.
- **TLS certificates are verified** for a desktop session — the gateway's and
  the host's. Until now any certificate was accepted in silence. One the system
  can verify is accepted and not stored, so a reissue is uneventful; anything
  else asks once with its fingerprint, remembers the answer, and warns loudly if
  it later changes. Refusing stops the session rather than falling back.
- Trusted certificates are listed and revocable under Settings → Security, kept
  apart from SSH host keys: the two have different lifetimes and revoking one
  should not touch the other.
- MD4 and RC4 are implemented here because NTLM needs both and OpenSSL 3 has
  moved them into the legacy provider, where turning them on would turn on every
  other withdrawn algorithm alongside them.

- **RDP desktops in a pane.** A host can be marked RDP and opens as a desktop
  beside the terminals, using the login already stored on it or on its group.
- A host now has a **protocol**, and a pane dispatches on it: the panels that
  ride on an SSH connection are hidden for a desktop rather than disabled.
- **Clipboard** across an RDP session, in both directions.
- Opening an RDP host offers a **choice**: a new session in the pane, or one of
  the sessions already logged on to that machine — watched or controlled. The
  list is read from the host with `qwinsta`. Joining one opens a window Windows
  draws rather than a pane, because the mechanism runs over RPC and SMB rather
  than RDP; Windows only.
- `TERMINALDECK_RDP_TRACE=1` turns on the local gateway's step-by-step report in
  a shipped build. It is on by default in development. The client reports nearly
  every fault as "General failure", so this is usually the only way to see where
  a session actually stopped.

### Notes

- None of the gateway path has met a real gateway yet. The pieces are tested —
  NTLM against the worked example in [MS-NLMP] 4.2.4, the tunnel handshake
  against a stand-in that answers each step and each refusal — but a first real
  attempt should be expected to fail on something small.
- The RDP client is IronRDP compiled to WebAssembly, and the main process
  impersonates a Devolutions Gateway on loopback to satisfy it. Nothing native
  is added and nothing external has to be installed, but the renderer bundle
  grows from about 1 MB to 7 MB, since the client ships inside it.
- The window's Content-Security-Policy gained three narrow allowances the client
  cannot run without; `src/renderer/csp.test.ts` states what breaks if they are
  removed.
- Reading the stored password for an RDP host is the only place a saved secret
  leaves the main process. It is scoped to one named host, because the client
  authenticates in the window and CredSSP cannot be done from anywhere else.

## 0.4.0

The first release since 0.1.9 — see the note above. Everything below had landed
after 0.3.2 without a version bump of its own.

### Added

- **Host-to-host copying.** Drag files or folders between two open SFTP panels
  and they are streamed from one server to the other, source socket to
  destination socket. The two hosts need no route to each other and nothing is
  staged on the local disk. Dropping onto a folder row lands inside that folder
  rather than in the directory being listed.
- **Remote monitoring**: a strip showing the logged-in user, processor load with
  a sparkline, memory, network throughput, uptime and per-mount disk usage. One
  probe command per tick reads it all from `/proc`; hosts that are not Linux
  leave the unknown fields blank rather than reporting zeroes.
- **Workspaces and collections**, appearance profiles, and inventory hosts that
  belong to more than one group.
- **On-connect commands**, a path bar in the SFTP panel, and an option to keep
  the file browser on the terminal's current directory.
- SFTP listings gained **mode, modification time and ownership** columns beside
  a folder tree.
- Hosts can be **reordered by dragging**, and connected to by double-clicking.

### Changed

- Every SFTP column is resizable, the name included. It used to absorb whatever
  the other columns left over, which meant its header grip did nothing and the
  last column was pushed off the right edge with no way to reclaim the space.
  The default panel width now fits all six columns.
- Deleting a host, or setting it back to inheriting, now forgets the credential
  it owned instead of leaving it in the vault.

### Fixed

- Planned transfers create missing intermediate directories. Only one level was
  created before, so uploading a nested folder into a destination that did not
  exist yet failed part-way through.
- Long-running dialogs no longer squash their scrollable sections to a few
  pixels. A scrolling child inside the modal's flex column absorbed the whole
  overflow instead of letting the card scroll — most visibly in Settings, where
  the trusted host keys list was clipped to a single half-height row.

## 0.3.2

Removed duplicated rules and split the store into slices.

## 0.3.1

Export and import, and a marker for connected hosts.

## 0.3.0

Find and open hosts in bulk, edit remote files, Windows agent fix.

## 0.2.1

Reach inventory hosts behind a bastion, and override groups.

## 0.2.0

Machine inventories from git, inherited credentials, folder transfers.

## 0.1.10

Connection reliability.

## 0.1.9

App icon, workspace restore, and session colours.

## 0.1.8

Context menus, clipboard handling, and log access.

## 0.1.7

Snippet library and a modal dismissal fix.

## 0.1.6

Tests, master password rotation, and trusted key management.

## 0.1.5

App-wide theming, auto-update, and release pipeline.

## 0.1.4

Terminal settings, cross-tab splits, and SFTP file management.

## 0.1.3

SSH config import, selective broadcast, and session tree management.

## 0.1.2

Host key verification, tunnel control, and usability shortcuts.

## 0.1.1

Fix terminal lifecycle across tabs and splits.

## 0.1.0

Scaffold: Electron + React + TypeScript SSH/SFTP terminal manager.
