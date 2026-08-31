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
  and a 15-minute idle auto-lock; the master password can be rotated without losing secrets.
  Deleting a host, a group, a repository or a local override takes its stored credential with it,
  rather than leaving it in the vault
- **Inheritance**: a session leaves fields unset to take them from its group, a group from its
  parent, and an inventory host from its repository — so a shared login is set once. Inheritance
  can be switched off per host or group. The nearest value wins, so a host that has a password of
  its own keeps using it after being moved into a group; its dialog says so, and setting the auth
  method back to **Inherit** drops that password in the same move, so the group's is used — one
  click, and reversible before saving
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
- The session tree connects on **double-click** — a single click only selects, so a stray one
  cannot open a terminal — and deleting a host or a group lives in the right-click menu behind a
  prompt, never as a button on the row
- Hosts are **sorted by hand**: drag one onto the upper or lower edge of another to drop it into
  that gap, in its group or into a different one, and the order is kept between launches
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

### Desktops

- **RDP sessions in a pane**, beside the terminals rather than in a separate window. A host is
  marked RDP in its own dialog and opens as a desktop; the login comes from the host or the
  group above it, like every other credential here, and a domain travels in the username as
  `DOMAIN\user`
- **A Desktop section on the host, the group and an inventory override**: the RD Gateway to
  reach the machine through, the resolution, and whether ⌘ is sent as Ctrl. It inherits along
  the same chain the login does, so a gateway shared by a floor of machines is stated once on
  the group and left blank on each host. Each field says what it would inherit and from where
- **The gateway is spoken to directly** — [MS-TSGU], implemented here: an HTTPS request to
  `/remoteDesktopGateway/`, an NTLMv2 sign-in carried in its headers, then a tunnel and a
  channel to the one machine being reached. Nothing native and no external client; the RDP
  exchange above it is unchanged and does not know it is in a tunnel
- **Both transports**, tried in that order. A current gateway upgrades the connection to a
  WebSocket and carries everything over it. An older one cannot, and gives no warning — the
  sign-in succeeds and the connection is then dropped with nothing said — so a failure there is
  not treated as final: the older transport follows, with a second connection, `RDG_OUT_DATA`
  carrying what the gateway says and `RDG_IN_DATA` carrying what the client says, one HTTP
  chunk per packet
- The sign-in binds to the connection it arrives over — `tls-server-end-point`, computed from
  the gateway's own certificate — because a gateway with Extended Protection turned on refuses
  an unbound sign-in with the same "access denied" it gives a wrong password
- Only **NTLM** is implemented. A gateway offering only Kerberos through SPNEGO says so plainly
  rather than failing as a refused password
- **Certificates are checked**, for the gateway and for the desktop host alike. One signed by an
  authority the machine already trusts is accepted silently and nothing is remembered about it,
  so a routine reissue changes nothing. Anything else asks once, with the fingerprint, and is
  remembered under Settings → Security → Trusted certificates; a certificate that later changes
  warns loudly rather than reconnecting. Refusing stops the session — it never falls back to
  connecting anyway
- The gateway takes the host's own login unless given one of its own, which is what
  "use my connection credentials" means in every other client. Its password is resolved in the
  main process and **never reaches the window** — unlike the host's own, which CredSSP forces
  into the renderer
- Resolution is either **fit**, where the desktop starts at the pane's size and the far end is
  asked to follow it on every resize, so every pixel stays its own, or **fixed**, where the desktop keeps a stated size and
  is scaled into the pane
- **The size is counted in the screen's pixels, not the pane's points.** A pane 1400 points
  wide is 2800 pixels on a Retina display, and which of the two the far end is asked for
  decides whether the picture is drawn pixel for pixel or magnified into place. The request is
  the screen's pixels divided by the magnification below, and capped by a **pixel budget** the
  host can set: past it the desktop is asked for a smaller size still rather than the one that
  was wanted. On a screen with one pixel per point — every ordinary monitor — the pane is the
  request whatever either is set to. Moving the window to a screen of another density
  re-negotiates the size, which a change of pane size alone would not
- **A desktop is drawn the size an ordinary monitor would give it.** Pixels and size are
  different questions: Windows lays out a 20-pixel menu the same way whether a pixel is a
  millimetre across or half of one, so a desktop asked for a Retina display's own pixels comes
  out sharp *and* half the size it should be. The far end could be told the density instead,
  and is not — its DPI is a setting of that machine, and a session someone else is logged on to
  would be resized under them. So the picture is **magnified here**: by default by the
  display's own density, which asks a Retina pane for exactly its points and draws every pixel
  as four. On an ordinary monitor that is a factor of 1 and nothing changes. A host, a group or
  an inventory override can pin the percentage instead — 100% asks for every pixel the screen
  has and is as sharp as the display gets, at the size that made this setting necessary
- **Or the session can be told the density**, per host and off by default. Then the far end
  lays its own interface out larger and the picture is not stretched at all — the same size at
  full sharpness, which is what a native client does and the only way to get it. What is sent
  is the factor actually asked for rather than the display's, so the pixel budget decides
  sharpness and never size. Off by default because it is still the far end being asked to lay
  itself out differently: DPI is agreed per connection rather than written into the machine,
  and only a session of this app's own is ever told — a joined session belongs to whoever is
  logged on to it and is never resized at all. Windows 8.1 and Server 2012 R2 and later act on
  it ([MS-RDPEDISP]); anything older ignores it and the magnification above is what is left
- **Full screen gives the whole display to the desktop.** The pane toolbar slides out of the
  way there and comes back on a brush of the top edge, so the size asked for is the display's
  own rather than the display less a toolbar — which matters beyond the room it frees, since a
  size no monitor has is the one that cannot land pixel for pixel. F11 enters and leaves, and
  holding Escape leaves; while there, Alt+Tab reaches the far side
- **Send ⌘ as Ctrl**, per host and off by default. Copy and paste then land where they do on
  Windows. While it is on and the desktop has the keyboard, this app's own ⌘ shortcuts do not
  fire; ⌘Q and ⌘Tab still belong to macOS
- **No native dependency and no external service.** The client is
  [IronRDP](https://github.com/Devolutions/IronRDP) compiled to WebAssembly, so the same build
  works on every platform. It insists on talking to a Devolutions Gateway, so the main process
  stands one up on loopback: a single-use address per session, which performs the X.224
  exchange and the TLS handshake and reports the server's certificate chain back — the client
  needs it because CredSSP binds to the server's public key
- Panels that ride on an SSH connection — the file browser, port forwarding, monitoring,
  broadcast — are hidden for a desktop rather than greyed out, since none of them is coming
- **Clipboard** in both directions, so text copied in the session pastes locally and back
- Opening a host asks what you want: a **new session** in the pane, or one of the sessions
  already logged on to that machine — watched, or with the keyboard and mouse taken. The list
  comes from the host itself and is read positionally rather than by column heading, so a
  translated Windows is read as well as an English one. Joining an existing session opens a
  window Windows draws, not this app: the mechanism runs over RPC and SMB rather than RDP, and
  no client that could be embedded here speaks it. Windows only, for the same reason
- **Listing sessions asks as whoever runs this app**, not as the login saved for the host —
  `qwinsta` authenticates its own RPC and no stored credential can change that. Against a
  machine outside your domain the practical answer is to run TerminalDeck as an account that
  host knows; failing that it tries PowerShell remoting with the saved login, which needs
  WinRM on the host and that host named in this machine's `TrustedHosts`. None of this touches
  ordinary RDP sessions, which need none of it
- Joining without the prompt is a **checkbox, off by default**. The host's policy decides
  whether it is permitted at all; where it is not, asking for it is refused outright rather
  than quietly falling back to asking
- When a session will not start, set `TERMINALDECK_RDP_TRACE=1` and the local gateway reports
  each step it took — whether the host answered, what it agreed to during protocol negotiation,
  whether TLS came up. The client reports nearly every fault as "General failure", so this is
  usually the only way to see where it actually stopped

### Files and networking

- SFTP browser: multi-select, context menu, rename, delete, mkdir, whole-directory transfers,
  Finder drag-and-drop upload, transfer progress, and auto-refresh
- **Host-to-host copying**: drag files or folders from one open SFTP panel onto another and they
  are streamed across, source socket to destination socket. The two servers need no route to
  each other, and nothing is staged on your disk on the way. Drop onto a folder row to land
  inside it rather than in the directory being listed
- Columns for size, modification time, **permissions** — `rwxr-xr-x`, setuid, setgid and the
  sticky bit included — owner and group. Name, mode and owner share one colour per kind: blue
  directories, cyan symlinks, red executables, so what a file is and what made it so sit side
  by side
- **Everything is draggable**: the panel by its left edge, the tree by its divider, and each
  column by its header. Widths are remembered. Ask for more width than there is and the
  listing scrolls sideways rather than dropping a column on you
- A **folder tree** beside the listing, filled in a level at a time as folders are opened. It
  reveals wherever the listing went, whether you clicked, typed a path, or the terminal `cd`-ed
- An **editable path box** with breadcrumbs: type or paste a path and press `⏎`. `~` and `..`
  are resolved by the server rather than guessed at, so they land where the shell would, and a
  path pointing at a file opens its folder with the file selected
- **Remote monitoring**: a strip under the pane with processor load and a short history of it,
  memory in use, network throughput, uptime, the logged-in user, and how full each mounted disk
  is, with a warning colour past 75% and an alarm past 90%. It polls on its own channel, so
  nothing is typed into your shell, and only while the strip is open
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

### Language

- **English or Russian**, switched in Settings and applied without a restart. The English text
  is what the translation is keyed by, so anything not yet translated appears in English rather
  than as a placeholder — and a test fails if a phrase is asked for that the book does not have,
  so the gap is always the screens nobody has been through yet rather than a line someone missed.
  Translated so far: Settings including its security and backup tabs, the shortcut list, the
  session tree, the tab strip, the pane toolbar, the host, group and inventory-override dialogs,
  Every screen is translated: 554 phrases, and a test fails on one the book has not got. What
  is deliberately left in English is the crash screen, which must not depend on the store it is
  reporting the failure of, and the status lines the app writes into the terminal itself

Press `⌘/` in the app for the full list of shortcuts and gestures.

## Status

Feature work is ahead of testing: the app is used daily against a couple of hosts, but several
paths have only ever been exercised by unit tests or by hand on a local stand-in.

**Written but not yet proven in real use**

- **The RD Gateway.** One real gateway, one account, one machine behind it: a desktop opens and
  works. That is one deployment and not a claim about gateways in general — the settings that
  decide whether a sign-in is accepted live on the server, and this one's are not every one's.
  When a session will not start, `TERMINALDECK_RDP_TRACE=1` reports each step it took
- **Host-to-host copying.** The planner is unit-tested, but the transfer itself — two SFTP
  channels piped together — has never run against two real servers, only been reasoned about
- Jump host / ProxyJump, including for inventory hosts
- Inventory sync from a *remote* repository — only a local `file://` clone has been run, so
  authentication through SSH keys and credential helpers is untested
- keyboard-interactive (2FA) authentication
- Port forwarding of every kind
- Per-session logging to file
- The Windows and Linux builds: CI produces them, nobody has installed them

**Deliberately not doing**

- Telnet and serial. Telnet is plaintext and only useful for legacy network gear; serial would
  pull in a native module and complicate every build. RDP *was* on this list — "a graphical
  client, not a terminal, and not doable well as a side feature" — until it turned out to be
  doable without a native dependency at all. See **Desktops** above.
- Joining an existing session **inside a pane**. It is offered, but the window belongs to
  Windows: the mechanism goes over RPC and SMB rather than RDP, and the embedded client does
  not implement it. Drawing it here would mean implementing Remote Desktop Services shadowing
  from scratch.
- The console session (`/admin`). The flag that selects it exists in IronRDP's protocol layer
  but is not exposed through its WebAssembly client, so this needs a change upstream.
  Connecting as the same user already reconnects to that user's existing session, which is
  most of what it is wanted for.
- PuTTY session import — Windows-only value, deferred since the MVP.
- Code signing and notarization. Configured and documented below, but no certificate is in use,
  which also means macOS auto-update downloads an update it cannot apply.

## Development

Node 22.12 or newer — Electron 43, Vite 7 and electron-vite 5 all refuse to run on less.

```bash
npm install
npm run dev
```

This opens the app with hot reload. The first `npm run dev` also downloads the Electron binary —
`npm install` no longer does, since Electron 42 dropped its `postinstall` script — so expect that
one to take a couple of minutes. On first launch you'll be asked to create a master password for
the local credential vault (stored in the OS user-data directory, never sent anywhere).

Syncing an inventory needs `git` on `PATH`; the Inventory tab says so if it is missing.

## Type-checking and tests

```bash
npm run typecheck
npm test
```

Tests cover the parts where a silent failure costs most: vault crypto, the `~/.ssh/config` and
Ansible inventory parsers, the credential and appearance inheritance chains, the pane tree, the
workspace selectors with the migration of layouts saved before workspaces existed, remote path
handling, the transfer conflict planner, and the diff engine. Also the readers that parse what a
host sends back — the `/proc` monitoring probe, `OSC 7` directory reports and the suppression of
their echo, permission bits — and the hand-sorting order, since all of these fail by quietly
producing a plausible wrong answer rather than by throwing.

Three of them cover what would lose data rather than merely misbehave, against a temporary
directory with no Electron and no host involved: rotating the master password carries every secret
across and a wrong one changes nothing; an export survives being imported on a machine whose vault
has a different master password, and each way of refusing a bad import leaves the existing stores
untouched; and a transfer writes what the conflict dialog allowed, skips what it did not, and — on
a host-to-host copy the source refuses to open — never creates the file on the far end.

Both commands also run on GitHub for every push and pull request
(`.github/workflows/ci.yml`), and again before a release is built, so a failure shows up next to
the commit that caused it rather than at tagging time. Much of what the tests cover — the Windows
session, gateway and NTLM code in particular — never executes on a Mac, which is where the app is
usually developed, so running them by hand is easy to skip and expensive to have skipped.

## Linting and formatting

```bash
npm run lint            # eslint, flat config in eslint.config.mjs
npm run format          # prettier --write
npm run format:check    # what it would change, without changing it
```

The rule set is small and was chosen from what the source already assumed: the fourteen
`eslint-disable` comments written here before any linter existed name `react-hooks/exhaustive-deps`
and `no-console`, so those are the rules that run, plus unused variables and the hook-order check.
The first run found three errors and one real stale-closure bug, and reported three of the eleven
`exhaustive-deps` suppressions as suppressing nothing at all. The eight that survived were then
read one by one and each given a sentence saying why it is there, so `exhaustive-deps` is now an
error — as is a suppression that has stopped suppressing anything, which is how those three came to
sit unnoticed.

Prettier is configured to the style the code was already written in — single quotes, no semicolons,
100 columns, no trailing commas — so a format pass should be close to a no-op. Markdown is left
alone deliberately; the prose here is wrapped by hand.

`npm run lint` runs in CI; `format:check` does not, since the tree has not been through Prettier
once yet and a check that starts out red teaches everyone to ignore it.

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

**The tag is what ships, not the version in `package.json`.** Editing the version by hand
changes what the app reports about itself and nothing else: no build runs, no release appears,
and nobody is offered the update. Versions 0.1.10 through 0.3.2 were bumped this way and never
published, which is why the newest release on GitHub is far behind the source.

`npm version` does both halves at once and is the only route that cannot drift:

```bash
npm version minor    # or patch / major — bumps package.json, commits, and tags
git push --follow-tags
```

It refuses to run on a dirty working tree, so commit first. If a version has already been set
by hand, tag that same version rather than bumping past it:

```bash
git tag "v$(node -p "require('./package.json').version")"
git push --follow-tags
```

The workflow checks the tag against `package.json` before building and fails on a mismatch, then
type-checks and runs the tests before anything is packaged.
Record what changed in [CHANGELOG.md](CHANGELOG.md) as part of the release commit.

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
delete the `mac.notarize: false` line in [electron-builder.yml](electron-builder.yml). From
electron-builder 26 the Apple environment variables are what turn notarization on, and that line is
the one thing that overrides them — it is there so that a build with no secrets doesn't fail at the
notarization step.

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
