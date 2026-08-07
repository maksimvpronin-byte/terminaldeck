# TerminalDeck

Cross-platform SSH/SFTP terminal manager — an in-progress alternative to MobaXterm / Royal TSX.
Built with Electron + React + TypeScript + [xterm.js](https://xtermjs.org/) + [ssh2](https://github.com/mscdex/ssh2).

## Features

### Machine inventories from git

- Point the app at a git repository holding an **Ansible inventory** and its hosts appear under
  an Inventory tab, alongside the hand-made sessions
- Cloned read-only through the **system git**, so existing SSH keys, agents, credential helpers
  and proxies apply as they do in a terminal; nothing is ever pushed
- Ansible groups, `children`, inline `vars`, `group_vars/` and `host_vars/` become groups and
  connection settings
- A host named by **several groups appears under each of them**, marked with the count, and stays
  a single host throughout — one set of local overrides, one entry in a collection, one terminal.
  Its connection settings are inherited from one group: the deepest, and alphabetically last
  within a level, which is the group Ansible itself would let win. Full Ansible variable
  precedence across every group is *not* implemented — where that matters, set the host's own
  local override
- A source follows **one branch** — the default one unless you name another — and the line under
  it states that branch, the revision, the host and group counts, and the files it read, so a
  sync that quietly followed the wrong branch or missed a file is visible rather than puzzling
- YAML inventories only: `.yml` and `.yaml`, with a directory read one level deep
- Local per-host and per-group tweaks are stored separately and re-applied after every sync

### Credentials

- Encrypted local vault (AES-256-GCM, master password via scrypt), with a lock button, `⌘L`,
  and a 15-minute idle auto-lock; the master password can be rotated without losing secrets
- **Inheritance**: a session leaves fields unset to take them from its group, a group from its
  parent, and an inventory host from its repository — so a shared login is set once. Inheritance
  can be switched off per host or group
- Host key verification against a local `known_hosts`, prompting on first contact and warning
  loudly when a stored key changes; stored keys can be reviewed and revoked
- **On-connect commands**: lines typed into the shell as soon as it opens — `sudo -i`,
  `cd /var/log`, `tmux attach` — inherited down the same chain, so a whole group can share an
  opening move. Read from local configuration only and **never from an inventory repository**,
  since that would hand command execution to anyone able to commit there
- Password prompt when nothing is stored, and **keyboard-interactive** support for 2FA
- Import hosts from `~/.ssh/config`, including `ProxyJump` links

### Terminals

- SSH via xterm.js with password / private-key / SSH-agent auth, and keepalive so idle
  sessions don't die silently behind NAT
- **Workspaces**: a top strip of named containers, each with its own row of tabs — open a whole
  host group or a whole inventory repository into one, with a tab per host. Tabs drag between
  workspaces without dropping their connection
- **Collections**: hand-picked sets of hosts, listed under the groups in the session tree and
  reopened as a workspace whenever you want them back. Unlike a group, a host can be in any
  number of them, membership has no effect on credentials, and a workspace can be saved as one
  before you close it. Hosts that later vanish are flagged rather than quietly dropped
- A collection also carries an **appearance profile** — colour and terminal theme — so a whole
  environment reads as one thing at a glance. It applies **by context**: a host wears the set's
  look where you see it under that set, and where you opened it from that set. The same machine
  in both *Prod* and *Databases* therefore looks like whichever one you came in through, and
  opening it from the ordinary tree involves no set at all. A host with settings of its own keeps
  them either way
- Tabs and split panes; drag a host or a whole tab onto a pane to place them side by side, and
  move a pane back out into its own tab
- **Broadcast** input to the terminals you tick, across every tab
- **Snippet library** (`⌘K`): saved commands, run or merely pasted, stating where they will land
- **Host palette** (`⌘P`) searching saved sessions and inventories together; tick several hosts
  in the tree with `⌘`/`⇧` click and open them as tabs or tiled in one
- **Appearance profiles**: font, size, colour theme, cursor and scrollback are set globally in
  Settings, and a group, an inventory repository or a single host can override them — each
  control says what it would inherit and from where, and inheritance can be switched off per
  host or group, independently of the credential inheritance. A host's theme recolours its own
  terminal, not the app
- Search (`⌘F`), zoom (`⌘+` / `⌘−` / `⌘0`, moving the host's own size when it has one),
  copy-on-select, right-click paste
- Colour-coded sessions, restored workspace and tab layout on launch, activity marks on
  background tabs and workspaces, and a green dot on hosts that already have a terminal open
- **Export and import** everything to one file to move machines or keep a backup; credentials
  are optional and re-encrypted under a password of their own
- Optional per-session logging to a local file

### Files and networking

- SFTP browser: multi-select, context menu, rename, delete, mkdir, whole-directory transfers,
  Finder drag-and-drop upload, transfer progress, and auto-refresh
- An **editable path box** with breadcrumbs: type or paste a path and press `⏎`. `~` and `..`
  are resolved by the server rather than guessed at, so they land where the shell would, and a
  path pointing at a file opens its folder with the file selected
- **Follow the terminal**, optionally: the `⇉` button in the path bar makes the panel track the
  shell's `cd`, and switches it back off, on the live connection — no dialog, no reconnect. It
  watches for the `OSC 7` sequence a shell prints on each prompt and types a one-line setup into
  the shell so hosts that aren't configured for it report it too — the echo of that line is taken
  back out of the stream, so it never reaches the screen. Off by default, since it lets the remote
  host move the file browser. The host or group setting decides only how a new connection starts
- **Overwrite confirmation, in both directions.** A transfer is planned before a byte moves, and
  anything it would replace is listed with the size and date on each side. Every clash starts on
  *Skip*, a folder standing where a file must go is refused rather than replaced, and no answer
  is remembered — each transfer asks afresh
- **Diff before you replace**: any clashing text file can be compared line by line without
  leaving the dialog, and any remote file can be compared against a local one from its context
  menu. Binary files and anything past 2 MB say so instead of being read across the wire, and a
  CRLF-only difference is reported as such rather than as a rewritten file
- **Edit remote files locally** — “Edit locally” in the file context menu opens it in the editor
  of your choice (Settings → Files) and uploads on every save
- Jump host / ProxyJump chaining, for saved sessions and inventory hosts alike
- Port forwarding — local, remote, and dynamic (SOCKS5) — auto-started per session with a
  runtime control panel

Press `⌘/` in the app for the full list of shortcuts and gestures.

## Status

Feature work is ahead of testing: the app is used daily against a couple of hosts, but several
paths have only ever been exercised by unit tests or by hand on a local stand-in.

**Written but not yet proven in real use**

- Jump host / ProxyJump, including for inventory hosts
- Inventory sync from a *remote* repository — only a local `file://` clone has been run, so
  authentication through SSH keys and credential helpers is untested
- keyboard-interactive (2FA) authentication
- Port forwarding of every kind
- Per-session logging to file
- The Windows and Linux builds: CI produces them, nobody has installed them

**Deliberately not doing**

- Telnet, serial and RDP. Telnet is plaintext and only useful for legacy network gear; serial
  would pull in a native module and complicate every build; RDP is a graphical client, not a
  terminal, and cannot be done well as a side feature.
- PuTTY session import — Windows-only value, deferred since the MVP.
- Code signing and notarization. Configured and documented below, but no certificate is in use,
  which also means macOS auto-update downloads an update it cannot apply.

## Development

```bash
npm install
npm run dev
```

This opens the app with hot reload. On first launch you'll be asked to create a master password
for the local credential vault (stored in the OS user-data directory, never sent anywhere).

Syncing an inventory needs `git` on `PATH`; the Inventory tab says so if it is missing.

## Type-checking and tests

```bash
npm run typecheck
npm test
```

Tests cover the parts where a silent failure costs most: vault crypto, the `~/.ssh/config` and
Ansible inventory parsers, the credential and appearance inheritance chains, the pane tree, the
workspace selectors with the migration of layouts saved before workspaces existed, remote path
handling, the transfer conflict planner, and the diff engine.

## Building installers

Each command compiles the app and packages it; artifacts land in `dist/`.

```bash
npm run build:mac       # .dmg and .zip, x64 + arm64
npm run build:win       # NSIS installer and a portable .exe, x64 + arm64
npm run build:linux     # AppImage and .deb
npm run build:mac:dir   # unpacked .app only — quicker, for checking a change
```

Add `-- --publish always` to upload the artifacts to a GitHub release.

**Each platform builds on itself.** electron-builder can only produce a package for the platform
it runs on here, because native dependencies (`cpu-features`, pulled in by ssh2) are rebuilt
against the target. Running `build:win` on a Mac fails on that step. Cross-building is possible
with Docker or wine, but the supported route in this repository is CI: pushing a `v*` tag builds
all three on their own runners (see Releasing below), which is also how the published releases
are made.

To try a local macOS build before it is signed, macOS will refuse to launch it until it carries
at least an ad-hoc signature:

```bash
npm run build:mac:dir
xattr -cr dist/mac-arm64/TerminalDeck.app
codesign --force --deep --sign - dist/mac-arm64/TerminalDeck.app
open dist/mac-arm64/TerminalDeck.app
```

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
  main/
    ssh/        Connection engine, SFTP, port forwarding, host keys, remote editing
    inventory/  git mirroring and the Ansible inventory parser
    vault/      Encrypted credential store
    store/      Saved sessions and snippets
    ipc/        Handlers exposed to the renderer
  preload/      contextBridge API exposed to the renderer as window.td
  renderer/     React UI (sidebar, tabs, split panes, terminal, SFTP browser, dialogs)
  shared/       Types, IPC channel names, and the credential and appearance inheritance rules
```

Where things are kept, all under the OS user-data directory:

| File | Holds |
| --- | --- |
| `vault.json` | Encrypted passwords and passphrases |
| `sessions.json` | Saved hosts and groups (no secrets) |
| `snippets.json` | Command library |
| `collections.json` | Saved sets of hosts (references only, no secrets) |
| `inventories.json` | Inventory sources and local overrides |
| `known_hosts.json` | Trusted host fingerprints |
| `inventory-repos/` | Read-only git mirrors |
| `logs/` | Session transcripts, when enabled |
