# TerminalDeck

Cross-platform SSH/SFTP terminal manager — an in-progress alternative to MobaXterm / Royal TSX.
Built with Electron + React + TypeScript + [xterm.js](https://xtermjs.org/) + [ssh2](https://github.com/mscdex/ssh2).

## Features


### AI diagnostics (development branch)

Open **Settings → AI assistant** and enter an OpenAI-compatible API base URL
(including its prefix, usually `/v1`), a model ID and an API key. Save the settings,
then use **Test AI connection**; this sends a small, potentially billable request
without server data. The API must support Chat Completions, `max_completion_tokens`
and text responses. The [API format](https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions/methods/create)
is used directly; Responses-only endpoints are not supported.

On a connected SSH pane, press **AI → Analyze**. This prepares an ordered plan;
it runs **no remote command**. Each command shows its exact text, host, reason,
rights and possible impact. **Run this command** authorizes that one execution;
**Skip command** records an omission. Results include stdout, stderr, exit status
and duration. The model interprets completed checks and can propose a different
next check, but that proposal also waits for approval. **Finish with collected
data** skips the remaining checks and requests a partial report with evidence links.

Disk diagnostics cover devices, mount options, free space/inodes, I/O samples,
kernel errors and software RAID. Follow-ups include service logs, SMART/NVMe,
LVM, ZFS, per-process I/O and limited directory-size checks. Missing utilities or
permissions are reported; nothing installs packages, elevates through sudo,
repairs a filesystem or restarts a service.

The API key and provider settings are encrypted in the vault. Enable data sharing
explicitly: filtered diagnostic output and log excerpts are sent to that provider.
Secret filtering is best-effort and cannot make arbitrary logs non-sensitive.
SSH credentials and terminal history are not collected by the assistant.
HTTPS is required except on loopback; redirects are refused and changing the
endpoint requires entering a key again. Provider settings are not included in
portable configuration backups.

Commands run sequentially in separate SSH channels with a 15-second deadline and
64 KiB combined output limit. A run has 14 base checks, at most 10 follow-ups,
24 model requests, 512 KiB collected output and a five-minute active-work budget;
waiting for approval does not consume that time. The model receives bounded head/tail
excerpts, not necessarily all retained output. Request context and response sizes
are also bounded. An exhausted budget or failed provider leaves collected results
visible rather than presenting an incomplete analysis as success.

Hiding the panel keeps it available. **Stop**, vault lock, SSH disconnect, window
reload/close or a provider-settings change cancels active work. Closing an SSH
channel is not a guarantee that every remote process has terminated. Reports live
only in memory for the SSH session. Findings are advisory and should be checked
against their evidence.

This branch has been exercised with local SSH and API fixtures, including the
Electron UI. Live-cloud and real-host acceptance testing still requires the
administrator's configured provider and a suitable test machine. No release is
published by this feature branch. See [the implementation plan](PLAN-ai-assistant.md).

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

### A Sessions folder tied to git

The Inventory tab is a place of its own. This is the same idea inside the ordinary tree: any
folder you make on the **Sessions** tab can mirror an Ansible inventory out of a repository, and
the hosts it brings in stand in the tree beside the ones you saved by hand.

- Edit a folder, tick **Mirror an inventory from a git repository**, and give it a URL, a branch
  and the paths to read — the same reader the Inventory tab uses, so `children`, inline `vars`,
  `group_vars/` and `host_vars/` mean the same things. Read-only through the system git;
  nothing is ever pushed
- **One repository per folder**, and the folder can hold your own sessions and subfolders as
  well — a sync never touches those
- A repository is **remembered once it has synced**, and offered in a list to every folder made
  afterwards. One inventory usually describes several environments in several files, so the second
  folder on it is a choice from that list plus its own paths — production out of one file, staging
  out of another. Folders that agree on the address and the branch **share one clone**: it is
  fetched once, and the working copy goes when the last folder reading it does
- **Nothing happens on its own.** What the last sync took is written to disk, so the folder shows
  its hosts on the first frame after the window opens, without going near the network. Going to
  git is **Sync with git…** on the folder, or the ⟳ button on its row
- Every sync **asks which groups to take**, before anything on disk changes: the previous choice
  is ticked, groups that appeared since last time are ticked and marked *new*, and a subgroup you
  untick stays unticked rather than being offered again as a discovery. Ticking a group takes its
  subgroups
- A sync brings the folder to what the repository says now, so **a group or host that has left it
  leaves the folder** — the dialog lists what is about to go, and how many of those hosts hold
  local settings, because those and any password saved for them go with them
- Hosts land in the folder as **one flat list**, however deeply the inventory nests them, and a
  host named by several Ansible groups appears once. The groups themselves are read and kept but
  not drawn: they are where a host's connection settings and `group_vars` come from, not where it
  is filed. Which groups a host came from is what the sync dialog is for
- Hosts arrive as **derived nodes with local settings layered on top**, exactly as on the
  Inventory tab: right-click one for *Local settings…*, and what you set there survives every
  later sync. Their connection settings inherit through the repository's groups and on up into
  the folder you made, so a login set on the folder covers everything under it
- A backup carries the repository, the branch, the chosen groups and your local settings — not
  the mirrored tree, which one sync on the new machine rebuilds
- Untying the folder, or deleting it, removes the mirrored hosts along with the local settings and
  passwords kept for them; the repository itself is untouched

### The tree

- Hosts **and folders** are sorted by hand: drag either one onto the top or bottom edge of a row
  and it lands in that gap, with a line showing where. A folder dropped onto the *middle* of
  another goes inside it, which is what dragging a folder has always done — the edges are the new
  part, and half the row still means "inside"
- The order is the one the store keeps, so it survives a restart, a rename and a move

### Credentials

- Encrypted local vault (AES-256-GCM, master password via scrypt), with a lock button, `⌘L`,
  and an idle auto-lock whose delay is set in Settings → Security — fifteen minutes by default,
  anything from a minute to eight hours, and able to be turned off entirely, since the right
  answer depends on the room rather than on the application, and eight hours is there because a
  working day is the span people actually asked not to be interrupted across; the master
  password can be rotated without losing secrets.
  Deleting a host, a group, a repository or a local override takes its stored credential with it,
  rather than leaving it in the vault
- **A lock stops the application, not only the picture.** The workspace is covered rather than
  torn down, so live sessions survive being locked — but it is put beyond reach of the keyboard as
  well as the mouse, and the main process refuses to start anything while the vault is shut: no
  new SSH session, no desktop, no file listing over SFTP. That last part matters because a host
  that signs in by key or through the agent never asks the vault for anything, so nothing else
  would have stood in the way. What is already running keeps running: locking is not
  disconnecting, and an editor saving a file it opened before the lock still uploads it
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
- **Saved accounts** (Settings → Accounts): logins kept on their own, belonging to no host and to
  no group. Right-click any host — saved or from an inventory — and **Connect as…** reaches it as
  one of them. That applies to the new tab alone: nothing is written back, so the host keeps the
  login it is saved with and every other connection to it is unaffected. The choice travels on the
  pane, so reconnecting signs in as the same account again, and the pane is named after it so a
  window signed in as somebody else says so.
  Only *who you are* is replaced — the port, the jump host, the on-connect commands and the
  gateway all stay the host's own. A gateway set to use the host's credentials is offered the
  chosen account too; the jump hosts on the way are still reached as they are configured to be.
  An account with no password saved is a deliberate arrangement rather than an incomplete one: the
  name and the login are remembered and the password is asked for each time. Works for desktops as
  well as shells, and passwords live in the vault exactly as a host's do
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
- **Connect several times…** in the same right-click menu opens one host in as many windows as
  you ask for, under whichever saved account you pick, as separate tabs, tiled into one tab, or
  in a workspace of their own. Each is a connection of its own and is numbered so they can be
  told apart; twenty at once is the limit, since every one of them is a real login on the far end
- **Host palette** (`⌘P`) searching saved sessions and inventories together; tick several hosts
  in the tree with `⌘`/`⇧` click and open them as tabs or tiled in one
- **Appearance profiles**: font, size, colour theme, cursor and scrollback are set globally in
  Settings, and a group, an inventory repository or a single host can override them — each
  control says what it would inherit and from where, and inheritance can be switched off per
  host or group, independently of the credential inheritance. A host's theme recolours its own
  terminal, not the app
- Search (`⌘F`), zoom (`⌘+` / `⌘−` / `⌘0`, moving the host's own size when it has one),
  copy-on-select, right-click paste
- **`Ctrl` belongs to the shell, on every platform.** Every shortcut here is on `⌘` on a Mac and
  on `Ctrl+Shift` elsewhere — the convention Windows Terminal and MobaXterm follow — so `Ctrl+C`,
  `Ctrl+D`, `Ctrl+K`, `Ctrl+W`, `Ctrl+L` and `Ctrl+F` reach the far end and mean what readline
  says they mean. Until 0.10.2 that held on a Mac alone: elsewhere the shortcuts sat on plain
  `Ctrl` and took exactly those keys, so `Ctrl+D` split the pane instead of ending the session.
  Two exceptions, both deliberate: `Ctrl+1 … Ctrl+9` still jump between tabs, since no shell has
  ever wanted them, and splitting downwards is `Ctrl+Shift+E` rather than a shifted `D`, because
  `Shift` is part of the modifier there and cannot also choose the direction
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
  reach the machine through, the resolution, whether the far end's sound plays here, and
  whether ⌘ is sent as Ctrl. It inherits along
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
- **Both of those are one control**, because they are one decision. Stretching the picture here
  and asking the far end to lay itself out larger are two answers to the same question, and
  they were a checkbox that greyed out a percentage — a shape that invites setting the
  percentage, ticking the box, and wondering why nothing happened. The list offers asking the
  far end, stretching here by this display's density or by a stated percentage, and not
  adjusting at all. Underneath they remain two settings: they inherit separately, and only one
  of them is anything the far end is ever told
- **Or the session can be told the density**, per host and off by default. Then the far end
  lays its own interface out larger and the picture is not stretched at all — the same size at
  full sharpness, which is what a native client does and the only way to get it. What is sent
  is the factor actually asked for rather than the display's, so the pixel budget decides
  sharpness and never size. Off by default because it is still the far end being asked to lay
  itself out differently: DPI is agreed per connection rather than written into the machine,
  and only a session of this app's own is ever told — a joined session belongs to whoever is
  logged on to it and is never resized at all. Windows 8.1 and Server 2012 R2 and later act on
  it ([MS-RDPEDISP]); anything older ignores it and the magnification above is what is left
- **Full screen gives the whole display to the desktop.** The pane toolbar leaves entirely
  there — not a strip of it stays, and while it is away it cannot take a click either. The far
  side keeps its own tab strip, menu bar and window buttons along that same top edge, and a
  toolbar over the picture is a toolbar over the very thing being reached for. It does not come
  back on a gesture either: every button on it carries a tooltip, a tooltip is a window of the
  operating system drawn above everything on the screen, and one shown as the strip slid away
  under a pointer that had not moved did not reliably come down with it — it stayed at the top
  of the display, over whatever was switched to next, taking every click inside it. So the size
  asked for is the display's own rather than the display less a toolbar — which matters beyond
  the room it frees, since a size no monitor has is the one that cannot land pixel for pixel.
  F11 enters and leaves, and holding Escape leaves; while there, Alt+Tab reaches the far side.
  On a Mac that is **⌥Tab**: `⌘Tab` is the system's own switcher, taken by macOS below the level
  any application can reach, so it never arrives — while `⌥Tab` is reserved for nothing there and
  lands on the far machine as the Alt+Tab that Windows is waiting for
- **Full screen hands the whole keyboard to the session.** Every shortcut this application owns
  stands down while a desktop is full screen — `⌘W`/`Ctrl+W`, the tab and workspace numbers, the
  snippet and host palettes, the vault lock, the zoom keys, and on a Mac the menu accelerators
  that never reached the window at all, `⌘W` for Close Window among them. A key aimed at the far
  machine landing on this one is the whole failure being avoided, and an exception list is how
  that comes back, so there is none: the two ways out are F11 and holding Escape, neither of
  which passes through the shortcut handling. In a window rather than full screen nothing
  changes — the app's shortcuts still fire, so the tabs stay reachable from the keyboard
- **Send ⌘ as Ctrl**, per host and off by default. Copy and paste then land where they do on
  Windows. ⌘Q and ⌘Tab still belong to macOS unless the session is full screen, where ⌘Q is
  forwarded like anything else and ⌘Tab is held by the browser's keyboard lock
- **The picture comes from a real RDP client, in a process of its own.** It is
  [FreeRDP](https://github.com/FreeRDP/FreeRDP) 3.31, built from source and shipped inside the
  application as a small program called `td-rdp`: it connects, decodes, and writes the
  rectangles that changed down a pipe as plain RGBA, which the pane puts straight onto a canvas.
  Nothing is re-encoded on the way, and there is no colour conversion anywhere — the bytes the
  decoder produced are the bytes `ImageData` takes
- **Which is what makes a desktop sharp and quick.** The whole graphics pipeline is negotiated:
  H.264 in both AVC420 and AVC444, progressive RemoteFX under that, and RemoteFX below it. The
  WebAssembly client this replaced had none of it — not disabled, absent — so a host that could
  have sent video sent run-length-encoded bitmaps instead, which on a 27" screen is what
  "blurry and slow" meant. See `PLAN-freerdp.md` for the evidence and the decision
- **A separate process, deliberately.** A fault in a decoder ends one pane rather than the
  window, nothing is tied to Electron's ABI, and the client signs in where it runs — so a
  stored password now goes from the vault straight down a pipe and never enters the renderer at
  all. The client before it authenticated inside the window, which forced the one exception
  this app made to that rule. That exception is gone
- **Sound**, played by the client itself through the platform's own audio, and switchable per
  host or group. It travels on its own channel, so it costs this side nothing and the link
  something — worth turning off where the line should be spent on the picture
- Panels that ride on an SSH connection — the file browser, port forwarding, monitoring,
  broadcast — are hidden for a desktop rather than greyed out, since none of them is coming
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
- When a session will not start, set `TERMINALDECK_RDP_TRACE=1`. The desktop client is then run
  at FreeRDP's `DEBUG`, which is what names the codecs and channels it agreed on with the host.
  It is kept, not printed — the last client taught that lesson expensively, several lines per
  frame into a console that holds every one of them, four gigabytes and an out-of-memory crash
  inside forty seconds. The main process keeps the last 400 lines per session and writes them to
  `logs/desktop-<time>.log` in the user-data directory only when asked. The client's own output
  cannot reach the pipe that carries the picture even in principle: it takes the real standard
  output for itself at startup and points descriptor 1 at the log, so a stray `printf` anywhere
  in FreeRDP or the libraries under it lands where it belongs rather than desynchronising a
  frame

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
  575 phrases, and a test fails on one the book has not got — though what it checks is that every
  phrase *asked for* has an entry, not that every line of text asks. A paragraph written straight
  into the markup is invisible to it, and a few remain: the group dialog, the first-run prompt and
  one menu item. What is deliberately left in English is the crash screen, which must not depend on
  the store it is reporting the failure of, and the status lines the app writes into the terminal

Press `⌘/` in the app for the full list of shortcuts and gestures.

## Status

Feature work is ahead of testing: the app is used daily against a couple of hosts, but several
paths have only ever been exercised by unit tests or by hand on a local stand-in.

**Written but not yet proven in real use**

- **The FreeRDP client itself.** It replaced the WebAssembly one on the strength of a
  side-by-side comparison against one host over one link, which is what the picture is for —
  and everything below the picture is new: input, the resize channel, the certificate question,
  the gateway. Built and proven on macOS. Windows builds in CI and ships complete — client,
  FreeRDP, OpenSSL, the codecs and the Visual C++ runtime — but no desktop pane has been opened
  on it yet: the build is proven, the session is not. Linux has no client build, so a desktop
  pane there says the client is missing rather than opening
- **The RD Gateway.** One real gateway, one account, one machine behind it: a desktop opens and
  works. That is one deployment and not a claim about gateways in general — the settings that
  decide whether a sign-in is accepted live on the server, and this one's are not every one's.
  When a session will not start, `TERMINALDECK_RDP_TRACE=1` reports each step it took
- **Host-to-host copying.** The planner is unit-tested, but the transfer itself — two SFTP
  channels piped together — has never run against two real servers, only been reasoned about
- Jump host / ProxyJump **for an inventory host**. A saved host through a saved bastion has now
  been run against a real pair — a Windows workstation with no route to the far machine at all,
  reaching it through a Linux jump host and signing in there with a key. What that run also
  showed is worth writing down: the two machines authenticate separately, and the far one is
  offered whatever this application holds for *it* — passing through a bastion is a tunnel, not
  a session, exactly as `ssh -J` behaves
- Inventory sync from a *remote* repository — only a local `file://` clone has been run, so
  authentication through SSH keys and credential helpers is untested
- keyboard-interactive (2FA) authentication
- Port forwarding of every kind
- Per-session logging to file
- The Windows and Linux packages. CI produces all three on every tag; nobody has installed
  either of those two

**Deliberately not doing**

- Telnet and serial. Telnet is plaintext and only useful for legacy network gear; serial would
  pull in a native module and complicate every build. RDP *was* on this list — "a graphical
  client, not a terminal, and not doable well as a side feature" — and came off it on the
  strength of a WebAssembly client that needed nothing native. That turned out to be the wrong
  trade: the client that asked nothing of the build also had no graphics pipeline, and the
  picture was the thing being paid for. There is now a compiled client, built per platform and
  shipped in the application. See **Desktops** above.
- **Clipboard and file transfer, for now.** Both rode on the previous client's own extensions
  and neither survived the change. FreeRDP speaks the channels — `cliprdr` for both — and they
  are the next piece of work rather than a decision against them. Said plainly here because it
  is a step backwards, and a real one: text copied in a desktop session does not paste out of
  it today.
- Joining an existing session **inside a pane**. It is offered, but the window belongs to
  Windows: the mechanism goes over RPC and SMB rather than RDP, and the embedded client does
  not implement it. Drawing it here would mean implementing Remote Desktop Services shadowing
  from scratch.
- The console session (`/admin`). FreeRDP carries the flag and nothing but a setting stands in
  the way now, so this is a small piece of work rather than an impossibility — it is simply not
  done. Connecting as the same user already reconnects to that user's existing session, which
  is most of what it is wanted for.
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

Both side panels are dragged by their inner edge and remember their width in the window
they were set in.

### Building the desktop client

Desktop panes need `td-rdp`, which is compiled rather than downloaded. It is not built by
`npm install` and not needed for anything else, so a checkout used only for SSH can skip this
entirely — a desktop pane will simply say the client is missing.

On macOS:

```bash
brew install cmake ninja pkg-config openssl@3 openh264 opus sdl2 sdl2_ttf sdl2_image
npm run build:freerdp:mac
```

That fetches FreeRDP 3.31.0, builds it and the shim into
`resources/freerdp/build/macos-<arch>/`, and keeps the whole log beside it. It takes a few
minutes and prints the failing lines itself if it does not finish. Changing a line of the shim
afterwards does not need any of that again:

```bash
npm run build:freerdp:shim
```

`npm run build:mac` runs `build:freerdp:bundle` first, which copies every library the build
actually uses in beside it, rewrites the absolute Homebrew paths to `@rpath`, and re-signs what
it touched — an unsigned Mach-O with a stale signature is refused outright on Apple Silicon, and
the symptom is a build that works only on the machine that made it.

On Windows, with Visual Studio and its C++ workload — 2017 or newer, whichever is installed —
plus CMake and Git on the path:

```
npm run build:freerdp:win
```

The libraries come from vcpkg rather than Homebrew — OpenSSL, openh264, opus and zlib. Point
`VCPKG_ROOT` at an existing one, or the script fetches its own into `resources/freerdp/vcpkg/`,
which costs a long first run and nothing afterwards. `-ShimOnly`, exposed as
`npm run build:freerdp:win:shim`, rebuilds only `td-rdp.exe`. The SDL client is deliberately not
built there: on macOS it is what proves the build by hand, and on Windows it would drag SDL2 and
two more packages through vcpkg for a program that is never shipped.

`npm run build:win` runs `build:freerdp:win:bundle` first, which copies the DLLs in beside
`td-rdp.exe` — Windows looks for them there, so there is no rpath to rewrite and no signature to
repair. It refuses to continue if the client has not been built, because a release without it
has a desktop pane that cannot open and the failure would reach whoever installed it rather than
whoever built it.

**The Windows script runs in CI on every tag**, and reaching that took its own five failures,
much like the five the macOS one took: em-dashes that PowerShell 5.1 reads as Windows-1252
until the file carries a UTF-8 BOM; CMake defaulting to the MinGW gcc that happens to sit on a
runner's `PATH`; a generator written down as `Visual Studio 17 2022` on an image that had moved
to Visual Studio 18, where CMake answers that it can find no Visual Studio at all; and a Visual
C++ runtime taken from the redistributable of a toolset older than the compiler doing the work.

The last two share a lesson, and it is written into the script: **it names no version.** vswhere
says which Visual Studio is installed, CMake's own list of generators supplies the matching
name, and the runtime comes from the newest redistributable rather than a folder named after a
year. A Visual Studio newer than the CMake beside it now says exactly that, instead of claiming
no Visual Studio exists.

Linux is not written yet.

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

### From a clone to an installer

Two commands per platform. The desktop client is compiled rather than downloaded, and packaging
builds it when it is not there — once, saying first that it is about to take half an hour.

**macOS** — produces a `.dmg` and a `.zip` for Apple Silicon:

```bash
brew install cmake ninja pkg-config openssl@3 openh264 opus
npm install
npm run build:mac
```

The first run builds FreeRDP, which takes about half an hour and says so before it starts. It
happens once: what it produces stays in `resources/freerdp/build/` and every later packaging run
reuses it.

Two extra packages — `sdl2 sdl2_ttf sdl2_image` — build the SDL client alongside it, which is
worth having when something is wrong and it is not clear which side is at fault: it reaches a
real host with the same code and no application around it. Packaging never includes it, so it is
`npm run build:freerdp:mac` on its own that wants them.

**Windows** — produces an NSIS installer and a portable `.exe` for x64. Needs Visual Studio with
the C++ workload — 2017 or newer, whichever is installed — plus CMake and Git on `PATH`:

```
npm install
npm run build:win
```

The libraries come from vcpkg rather than Homebrew. Set `VCPKG_ROOT` to an existing one, or the
script fetches its own into `resources/freerdp/vcpkg/`.

The Visual C++ runtime is copied in beside the desktop client, from the redistributable that
ships with Visual Studio. Without it the portable build starts on a machine that has never had
Visual Studio and cannot open a desktop pane — which is the machine a portable build exists for.

The one taken is the newest installed, which is the one matching the compiler that did the work.
A runtime older than its own toolset is the single direction that is not allowed to work, and it
fails on a machine with no Visual Studio — again, the only machine this exists for.

**Linux** — produces an AppImage and a `.deb`:

```bash
npm install
npm run build:linux
```

No desktop client is built there yet, so a desktop pane on Linux says the client is missing
rather than opening. Everything else works.

### Afterwards

```bash
npm run build:mac:dir   # unpacked .app only — quicker, for checking a change
npm run build:freerdp:shim        # rebuild only the client's own C, in seconds
npm run build:freerdp:win:shim    # the same on Windows
```

Add `-- --publish always` to any of the packaging commands to upload the artifacts to a GitHub
release.

macOS packages Apple Silicon only and Windows x64 only, because the desktop client is built by
the machine that packages it. Building for the other architecture means running the whole
sequence on a machine of that architecture.

**Each platform builds on itself**, and now each architecture too. electron-builder can only
produce a package for the platform it runs on here, because native dependencies (`cpu-features`,
pulled in by ssh2) are rebuilt against the target — running `build:win` on a Mac fails on that
step. The desktop client adds the second half of that rule: it is compiled by the machine doing
the packaging, so the package carries that machine's architecture. Cross-building is possible
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
artifacts and drafts a GitHub release from them. It is a **draft**: electron-builder leaves it
unpublished, and the in-app updater ignores drafts, so nothing is offered to anybody until
somebody looks at what was built and presses Publish.

Each runner compiles the desktop client for itself before packaging — that is the slow part,
half an hour the first time. It is cached on the FreeRDP version and on that platform's own
build recipe, so editing the Windows script no longer throws away the macOS cache. vcpkg's
packages are cached separately and more loosely: what they hold does not depend on how FreeRDP
is built afterwards, so they survive a change of recipe that the build itself must not. The shim
is rebuilt every time regardless, because it is seconds and it is ours.

macOS ships Apple Silicon only and Windows x64 only, because the client is built by the runner
that packages it and those are the architectures the runners are. Adding the other two means a
second job apiece, each building its own client.

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

## Installing a release on macOS

The macOS build is signed **ad-hoc**, which is what a build with no certificate can do for itself:
it makes the application runnable, and nothing more. On the first launch macOS says the developer
cannot be verified — open **System Settings → Privacy & Security**, where the blocked application
is named, and press **Open Anyway**. From then on it opens normally.

Without even that ad-hoc signature — which is how every build before 0.9.0 shipped — macOS reports
the download as *"TerminalDeck is damaged and can't be opened"* and offers to move it to the Trash.
Nothing is damaged: on Apple Silicon the kernel refuses to run an executable that carries no
signature at all, and that is the message it produces. An older DMG can be opened after:

```bash
xattr -dr com.apple.quarantine /Applications/TerminalDeck.app && codesign --force --deep --sign - /Applications/TerminalDeck.app
```

The real answer to both is a Developer ID certificate and notarization, below — which is also what
macOS auto-update needs.

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

Until those secrets exist, [resources/adhoc-sign.js](resources/adhoc-sign.js) signs the bundle
ad-hoc after packing — it does nothing at all once `CSC_LINK` is set, so a real signature is never
overwritten by a worthless one.

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
| `credentials.json` | Saved accounts — names and vault references, no secrets |
| `inventories.json` | Inventory sources and local overrides |
| `known_hosts.json` | Trusted host fingerprints |
| `inventory-repos/` | Read-only git mirrors |
| `logs/` | Session transcripts, when enabled |
