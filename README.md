# TerminalDeck

Cross-platform SSH/SFTP terminal manager — an in-progress alternative to MobaXterm / Royal TSX.
Built with Electron + React + TypeScript + [xterm.js](https://xtermjs.org/) + [ssh2](https://github.com/mscdex/ssh2).

## Features

- Encrypted local vault (AES-256-GCM, master password via scrypt) for passwords and key passphrases,
  with a lock button, `⌘L`, and a 15-minute idle auto-lock
- Host key verification against a local `known_hosts`, prompting on first contact and warning
  loudly when a stored key changes
- Session manager: nested groups, tags, drag-and-drop organising, filtering, quick-connect
- Import hosts from `~/.ssh/config`, including `ProxyJump` links
- SSH terminals via xterm.js with password / private-key / SSH-agent auth
- Tabs and split panes; drag a host or a tab onto a pane to place them side by side
- Broadcast input to selected terminals across every tab
- SFTP browser: multi-select, context menu, rename, delete, mkdir, Finder drag-and-drop upload,
  transfer progress, and auto-refresh
- Jump host / ProxyJump chaining
- Port forwarding — local, remote, and dynamic (SOCKS5) — auto-started per session with a
  runtime control panel
- Terminal search (`⌘F`), configurable font/theme/scrollback applied app-wide
- Optional per-session logging to a local file
- Auto-update from GitHub Releases

Not yet done: PuTTY session import, automated tests.

## Development

```bash
npm install
npm run dev
```

This opens the app with hot reload. On first launch you'll be asked to create a master password
for the local credential vault (stored in the OS user-data directory, never sent anywhere).

## Type-checking

```bash
npm run typecheck
```

## Building installers

```bash
npm run build:mac     # dmg + zip, x64 + arm64
npm run build:win     # nsis installer + portable exe
npm run build:linux   # AppImage + deb
```

Add `-- --publish always` to upload the artifacts to a GitHub release.

## Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds macOS, Windows and Linux
artifacts and publishes them to a GitHub release. The in-app updater reads that release.

```bash
npm version patch    # or minor / major — creates the commit and tag
git push --follow-tags
```

## Code signing and notarization

Unsigned builds run locally but are unpleasant to distribute: macOS Gatekeeper blocks them and
Windows SmartScreen warns about them. **Auto-update on macOS only works on a signed app** —
`electron-updater` verifies the signature before swapping the bundle, so an unsigned macOS build
will download an update and then refuse to apply it.

To sign, add these repository secrets (they are read by the release workflow; absent secrets simply
produce an unsigned build):

| Secret | Purpose |
| --- | --- |
| `CSC_LINK` | Base64 of the `.p12` certificate (Developer ID Application on macOS, code-signing cert on Windows) |
| `CSC_KEY_PASSWORD` | Password for that `.p12` |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Apple Developer team ID |

A Developer ID certificate requires a paid Apple Developer account. Once the Apple secrets exist,
flip `mac.notarize` to `true` in [electron-builder.yml](electron-builder.yml) — it is `false` by
default so unsigned builds don't fail at the notarization step.

Entitlements live in [resources/entitlements.mac.plist](resources/entitlements.mac.plist) and are
required under the hardened runtime: Electron needs the JIT entitlements, and the app needs
network client/server access for SSH and for local port-forward listeners.

## Project layout

```
src/
  main/       Electron main process — SSH/SFTP/port-forward engines, vault, session store, IPC
  preload/    contextBridge API exposed to the renderer as window.td
  renderer/   React UI (sidebar, tabs, split panes, terminal, SFTP browser, dialogs)
  shared/     Types and IPC channel names shared between main/preload/renderer
```
