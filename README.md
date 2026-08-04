# TerminalDeck

Cross-platform SSH/SFTP terminal manager — an in-progress alternative to MobaXterm / Royal TSX.
Built with Electron + React + TypeScript + [xterm.js](https://xtermjs.org/) + [ssh2](https://github.com/mscdex/ssh2).

## Status: MVP scaffold

Implemented so far:

- Encrypted local vault (AES-256-GCM, master password via scrypt) for passwords / key passphrases
- Session manager: groups, tags, quick-connect, saved SSH profiles
- SSH terminal via xterm.js with password / private-key / SSH-agent auth
- Tabs, with split panes (horizontal/vertical) per tab
- SFTP file browser (list / upload / download / mkdir / delete / rename) per connection
- Jump host / ProxyJump chaining (a session can point at another saved session as its jump host)
- Port forwarding: local, remote, and dynamic (SOCKS5)
- Optional per-session logging to a local file

Not yet done: code signing, auto-update, PuTTY session import, Linux packaging polish, automated tests.

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

Builds are currently **unsigned**. Code signing / notarization is a follow-up task before
distributing outside your own machine.

## Project layout

```
src/
  main/       Electron main process — SSH/SFTP/port-forward engines, vault, session store, IPC
  preload/    contextBridge API exposed to the renderer as window.td
  renderer/   React UI (sidebar, tabs, split panes, terminal, SFTP browser, dialogs)
  shared/     Types and IPC channel names shared between main/preload/renderer
```
