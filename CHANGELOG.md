# Changelog

The version in `package.json` is the one the app reports and the one
`electron-updater` compares against. A `v*` tag matching it is what actually
publishes a release — see [Releasing](README.md#releasing). Bumping one without
the other produces a version nobody can install, which is how 0.1.10 through
0.3.2 came to be written and never released: no tag, so no build ever ran.

## Unreleased

### Added

- **RDP desktops in a pane.** A host can be marked RDP and opens as a desktop
  beside the terminals, using the login already stored on it or on its group.
- A host now has a **protocol**, and a pane dispatches on it: the panels that
  ride on an SSH connection are hidden for a desktop rather than disabled.
- **Clipboard** across an RDP session, in both directions.
- `TERMINALDECK_RDP_TRACE=1` turns on the local gateway's step-by-step report in
  a shipped build. It is on by default in development. The client reports nearly
  every fault as "General failure", so this is usually the only way to see where
  a session actually stopped.

### Notes

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
