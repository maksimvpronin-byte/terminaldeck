# Changelog

The version in `package.json` is the one the app reports and the one
`electron-updater` compares against. A `v*` tag matching it is what actually
publishes a release — see [Releasing](README.md#releasing). Bumping one without
the other produces a version nobody can install, which is how 0.1.10 through
0.3.2 came to be written and never released: no tag, so no build ever ran.

## 0.15.5

### Fixed

- Send a file to a desktop that something here already has open. WinPR opens a
  file it is about to put on the clipboard with no sharing at all, so a file
  Explorer was previewing — or an editor was holding — failed *after* its
  descriptor had been sent, which reads as a paste that half worked. The Windows
  build now permits other readers while still excluding writers, and refuses to
  build at all if FreeRDP's own code has moved out from under the change, so an
  upgrade cannot drop it quietly. The shim's test opens the file first and then
  asks for it, which is the case that used to fail.
- Say when sending a file fails instead of failing silently. Three paths that
  serve a local file's size or contents answered the far end with a refusal and
  told nobody: a paste in the session did nothing, with no reason anywhere. They
  reach the pane now, as the transfer status already did.

## 0.15.4

### Added

- Copy files out of a desktop as well as into one. RDP hands files over as a
  list of descriptors and then in ranges on request, and FreeRDP's own answer to
  presenting those locally is FUSE, which macOS does not have — so they are
  fetched into a private temporary directory and the paths put on the clipboard
  when the last byte lands. The pane says what is happening and says when it is
  done: paste after **Files ready to paste**, not before. A newer copy cancels
  an unfinished fetch rather than racing it, and the temporary copies go when
  TerminalDeck quits, so paste what you need before closing it.
- Read the files on the clipboard through the platform rather than around it. A
  pasteboard holds several files as several items and Electron reads only the
  first, so a copy of more than one file arrived as one file — the way out is
  AppKit's own `NSURL` reader on macOS and the file drop list on Windows, asked
  for in a short-lived helper. That helper also carries the clipboard's version
  with it, so a transfer that took seconds cannot overwrite something copied
  while it ran: the check happens inside the process doing the writing.

### Fixed

- Stop the application dying when a desktop pane is closed. A session leaves the
  bridge's list when its process exits, which is some time after its input has
  been closed — so between the two there is an entry that looks live and has
  nowhere to write. The clipboard poll speaks every quarter of a second and
  found it: writing to a closed pipe raises `ERR_STREAM_WRITE_AFTER_END` on the
  stream rather than at the call, and a stream nobody is listening to turns that
  into an uncaught exception, which ends the process rather than the write. A
  session on its way out is now refused by the one place everything writes
  through, and saying something to a client that has already gone is treated as
  the ordinary end of a session rather than as a fault.

## 0.15.3

### Added

- Copy files into a desktop. A desktop pane has no SFTP — RDP has no shell to
  hang one off — so until now there was no way at all to put a file on a Windows
  machine from here; the clipboard is that way. Copy in Finder, paste in the
  session: single files, several at once, and directories, which are walked on
  the far end's behalf. Nothing is copied anywhere to be offered, so the size of
  what you copy does not matter: FreeRDP's file helper reads the bytes off this
  disk in ranges when the far end asks for them, and it only asks when somebody
  pastes. The list of paths turns into the descriptors the far end expects at
  that moment too, since building them means stat'ing every file.

  Copying files *out* of a session is not here yet. FreeRDP answers that with
  FUSE, which macOS does not have, so it has to be written rather than wired up.

## 0.15.2

### Fixed

- Read what the far end put on its clipboard as the format we asked for, not as
  the format it last asked *us* for. `lastRequestedFormatId` belongs to the
  channel and is set in one place only — when the server requests data from the
  client — so using it to decode the server's *answer* read one direction's
  state for the other's. Before the remote had ever asked us for anything it is
  zero, which is not `CF_UNICODETEXT`, so the very first copy from a session was
  decoded as bytes: UTF-16 travelled up as if it were text, came back as
  mojibake, and pasting it into the session showed a space, a box, a digit, a
  box. The client tracks its own outstanding request now, and keeps one in
  flight at a time — a format data response carries no format id, so two of them
  cannot be told apart. A newer offer arriving mid-request replaces what is
  fetched rather than racing it, and a response nobody asked for is dropped.
- Let go of everything hanging off a connection when the shell ends on its own.
  The SFTP channels, the remote edits, the monitor and the forwarded ports were
  released only when somebody closed the pane by hand; `exit`, or a dropped
  link, left all four behind. The forwarded port is the one with teeth: it went
  on listening, bound to a connection that no longer existed, so it forwarded
  nothing and the next attempt to open the same tunnel was refused the address.
- Carry the password an RD Gateway keeps in a backup. The export collected
  `secretRef` and not `gatewaySecretRef`, so the field travelled and the secret
  behind it did not — and a restored host said "saved on this host" about a
  password the vault had never heard of. Lost while claiming otherwise is the
  version nobody goes looking for until the gateway refuses them.
- Say nothing to a window that is not listening yet. A connection's channels are
  named after its id, and the renderer only learns the id when `connect`
  resolves, so everything sent in between went to a channel nobody was on and
  Electron dropped it. The shell's greeting went that way now and then; the
  message about a tunnel that failed to come up went that way every time, since
  it is sent while `connect` is still working. The session holds its first words
  until the window says it has subscribed, delivers them in the order they were
  said — including to a window that only asks after the connection has already
  died, where what was held is the reason it died — and gives up waiting after
  five seconds, in case no window ever speaks.

## 0.15.1

### Fixed

- Ask for updates again while the application is running. It asked once, at
  startup, so a copy left open across a release never heard about it — which on
  a machine nobody reboots means never, and is why 0.15.0 was published and
  nothing offered it. It asks on the hour now, and stops asking while there is
  already an answer to act on: re-announcing an update somebody left for later
  is noise, and asking mid-download would interrupt it.
- Give a host's name back the width an invisible button was holding. An Edit
  button sat at the right end of every row in the Sessions tree, hidden until
  the row was hovered and laid out regardless — which is what `visibility:
  hidden` does — so every name ended in an ellipsis with visible empty space
  after it. Forty pixels a row for a host, sixty for a folder, where Sync with
  git and New subgroup sat. All three have been in the context menu all along,
  and deleting was only ever there. A folder still says when a sync is running:
  an ellipsis beside its name, which is what the button turned into.

### Added

- **Check for updates** in Settings → Backup, beside the version this build
  calls itself. It answers either way — a check by hand that says nothing when
  the news is good reads as a broken button.

## 0.15.0

### Changed

- A host's colour is the ground its row stands on, not a dot beside it: a wash of
  the colour across the row and a 3px edge down its left side. The edge survives
  selection, which paints over the wash — the row you just clicked is the one you
  were hunting for by colour, and it must not lose it at the moment of being
  found. The wash is deliberately faint: at full strength a tree with half its
  hosts coloured reads as a striped blanket.
- The slot the dot left now says what a row *is*: a terminal window for SSH, a
  monitor for RDP, drawn rather than typed. It is the first thing worth knowing
  about a Windows machine in a list of Linux ones, and until now the tree did not
  say it anywhere. Both trees, Sessions and Inventory.
- Say whether a machine is open on the icon in front of its name, which turns
  green on a faint green plate, instead of on a 6px green dot after it. The dot
  lived inside the ellipsised name, so it vanished exactly in the rows whose
  names did not fit — the rows in a deep folder, which is where most hosts are.
  A desktop counts as open now too: only a terminal ever reported its session,
  so an open desktop was indistinguishable from a closed one. It reports through
  a field of its own rather than the connection id, which is an SSH handle that
  SFTP, tunnels, monitoring and broadcast all write over — and a new pane opts
  into broadcast by default, so an RDP session id in that list would be typed
  into.
- Tighten the tree's indentation, which compounded faster than it looked: a base
  of 8, a step of 12 and a whole extra step for a host put a name 58px into a
  260px panel three levels down, with nothing left to read it in. The base is 4,
  the step 10, and a host is nudged 8 inside its group rather than given a level
  — it has no chevron to make room for, and the icon landing under the folder
  above it already says "inside". The geometry is written down once now, in
  `treeIndent.ts`, because both trees draw it and they have to agree.

### Added

- Share the clipboard with a desktop, text in both directions. The client speaks
  `cliprdr` now: it announces what this side holds, asks for what the far end
  offers, and answers when the far end pastes. What is copied here is announced
  rather than sent, because most of it never gets pasted there. On, as every
  Windows client has it, and turned off per host or group: it is the one setting
  under Desktop that moves data rather than deciding how a picture is drawn, and
  anything running on the far machine can read a clipboard, not only the window
  being pasted into.
- The help says which build it belongs to, at the top right, where somebody
  writing a bug report will look for it.

### Fixed

- Open a host mirrored from a repository as what it is. A pane read the protocol,
  the address and the port out of the saved sessions alone, and a host from an
  inventory is not in that list — so every one of them answered "no such host",
  which for a protocol means SSH. A Windows machine from a repository therefore
  opened a terminal and dialled 3389 as SSH however the inventory described it,
  and the same lookup lost the address and the port on the way, which is the only
  reason it reached the host at all. An open desktop pane now also notices a sync
  or a local override, which it never did for such a host.

## 0.14.0

### Added

- Read a host's protocol from a git inventory. Every host from a repository was
  an SSH host with no way to say otherwise: a Windows machine opened a terminal,
  took the port the inventory stated and dialled it as SSH, which fails as a
  connection reset rather than as anything a person could act on. The reader now
  takes `terminaldeck_protocol: rdp` on a host or a group, and only that —
  `ansible_connection` describes how Ansible manages a machine, not how somebody
  uses one. Such a host ignores `ansible_port`, which is the management port, and
  takes `terminaldeck_port` when the desktop is not on 3389.
- Worked inventory examples in the help and in the Russian manual, since the
  variable is only useful to somebody who can see where it goes: the group form
  that covers a whole set of machines, a host disagreeing with its group, the
  `group_vars` file that says the same thing, and the port pair that shows which
  of the two is read.
- State the protocol in a host's local settings, for a repository you cannot
  edit. It is the one setting in that dialog that is not inherited — a group
  holds a Linux box and a Windows one alike — and switching it reveals the
  Desktop section without saving and reopening.

### Removed

- Joining a session somebody else is already working in, and everything under it:
  the session picker in a desktop pane, the listing of who is logged on to a
  Windows host, `ShadowHost.exe` and the `mstsc /shadow` window it held open.
  The picture was never this application's to draw — the mechanism goes over RPC
  and SMB rather than RDP — so the pane positioned a window Windows drew, which
  kept its own size, could not be reached by Alt+Tab even full screen, and needed
  the host queried as whoever started the application rather than as the saved
  login. Nearly every feature of a desktop pane had an exception written for it.
- The research the feature grew out of: the `shadowprobe` and Remote Assistance
  native experiments and the two notes describing them. The reading of IronRDP's
  channels stays in `docs/ironrdp-channel-gap.md`, since it is still why the
  drawn client is FreeRDP.
- With them, the `build:shadowhost` script, the packaging entry that carried
  `ShadowHost.exe` into the Windows build, and the two release-contract rules
  that existed to keep those two honest.

### Fixed

- Stop offering an in-place update on macOS to a build that cannot install one.
  Without a Developer ID the bundle is signed ad-hoc, and Squirrel.Mac replaces
  the application only when the new signature satisfies the running one's
  requirement — which an ad-hoc signature never does. Such a build now reports
  the new version with a link to the downloads instead of fetching the whole
  package and failing at the last step. The signing hook marks the bundle, and
  the release contract checks the marker against the signature both ways.

### Documentation

- Rename the Russian manual to `docs/terminaldeck-manual.html`, without the
  version it had gone out of date against, and bring it up to this one.
- Say in the help what pausing in a background tab looks like: the file listing,
  the monitor and the desktop picture stop while a tab is not being looked at,
  and what happens on return.

## 0.13.2

### Performance

- Avoid notifying the global UI store for terminal output when the tab is already
  visible or already marked unread. SSH batching, flow control and WebGL rendering
  remain in use.
- Limit file-transfer progress updates to ten per second, with immediate final
  notifications, and render the progress bar independently of the file list.
  Large directories now render only visible rows, preserving selection, rename
  editors and drag sources while scrolling.
- Pause automatic file listings and monitoring in hidden tabs and when the window
  is hidden. Refresh when returning; SSH connections and transfers stay alive.
  Slow file listings no longer accumulate overlapping polling requests.
- Stop transporting RDP pixels while a desktop pane is hidden. Restore the full
  current screen on return without reconnecting or exceeding one frame in flight.
- Coalesce split resizing to animation frames, skip unchanged terminal dimensions,
  and save the layout after dragging instead of on every mouse movement. Other
  layout saves are debounced, with a bounded delay and a flush when closing.
- Check transfer destinations with up to eight concurrent metadata requests while
  preserving conflict handling and sequential file writes. Concurrent requests
  share one SFTP channel-opening operation.
- Read and parse inventory YAML in a worker thread, cache variable files within a
  parse, and merge hosts and groups with maps instead of repeated linear searches.
  Shared Git checkouts remain locked through parsing and revision lookup.

### Fixed

- Lock accidental cross-axis trackpad noise to the dominant RDP scroll axis while
  preserving explicit horizontal and deliberate diagonal gestures.
- Ignore outdated file listings after changing directory or connection.
- Preserve the initial selection anchor when Shift-clicking across a large list.
- Reject SFTP channel creation that completes after its connection was released.
- Ignore monitoring results from a stopped or replaced watch.

### Validation and documentation

- Add regression coverage for activity notifications, deferred layout saves,
  10,000-file listings, background panels, transfer progress and concurrency,
  inventory merging and RDP visibility. Native frame tests run during client builds.
- Update the Russian 0.13 manual for background polling and desktop behaviour.

## 0.13.1

### Documentation

- Add a Russian user manual as a single self-contained page,
  `docs/terminaldeck-0.13-manual.html`: installation and first run, the tree and its
  inheritance, credentials and the vault, terminals, files over SFTP and the new SCP/Shell
  access, tunnels, monitoring, git inventories, desktops, backup, the shortcut tables and
  a troubleshooting section. Its wording follows the Russian interface, so what it names
  is what is on screen. Shortcuts are written in mac notation and rewritten for Windows and
  Linux by a switch in the page header, the way `keyHint` does it in the app — including the
  three places where the other platform's shortcut is not a mechanical translation: tab
  numbers and zoom sit on plain Ctrl, splitting downwards is Ctrl+Shift+E, and ticking a host
  is a Ctrl-click. The tables in the shortcut section print both columns either way.

### Added

- Add SCP/Shell file access to saved hosts and local Git inventory overrides.
  A command such as `sudo -n -i -u postgres` runs file operations as the permitted
  account without changing the SSH terminal login. Includes directory browsing,
  file transfers, host-to-host copies and external-editor uploads. Requires a
  Linux server with GNU tools and non-interactive command authorization.
- Preserve file-access settings in backups and show the active SCP/Shell command
  in the file panel. Existing connections continue to use SFTP by default.

## 0.13.0

### Added

- Add “Arrange hosts in group folders” to Git inventory sync. Selected groups
  appear as nested folders, shared hosts appear in each selected group, and the
  layout choice is remembered for subsequent syncs. Leave the option off to
  keep the existing flat host list.

### Fixed

- **A host with a slow login showed the directory-tracking setup line.** The line
  that teaches a shell to report its directory was typed in the instant the channel
  opened — while a login shell was still working through `/etc/profile`, with no line
  editor running yet. The tty driver echoed it into the middle of the banner and the
  editor drew it again after the prompt, so the copy the suppressor removed was never
  the copy on screen; a banner longer than eight kilobytes exhausted the suppressor's
  budget on its own. The line now waits for the shell to fall quiet before it is sent,
  which also keeps anything in the profile that reads from the terminal from eating it,
  and the suppressor removes every echo of it rather than the first while passing
  untouched output straight through.

- **A desktop that would not open said what step failed and never why.** The client's own
  log — where the reason is written, one line before it stops — was read only to keep its
  pipe from filling and then discarded, so "the connection failed at negotiating security
  settings" was all anyone ever saw, for a host that refused every security level offered
  and for a connection that broke mid-negotiation alike. The pane now quotes the client's
  last complaint alongside FreeRDP's summary and states the numeric error code, and
  `TERMINALDECK_RDP_TRACE=1` prints the whole log to the terminal instead of nowhere.

## 0.12.2

### Maintenance

- Update the transitive `js-yaml` dependency to address its merge-key CPU
  exhaustion advisory (GHSA-2883-xcg3-v3hh).

- Remove the retired IronRDP loopback gateway, its MS-TSGU/NTLM transport
  implementation and tests. Desktop connections continue to use FreeRDP.
- Remove unused Remote Assistance prototypes and standalone shadow probes;
  preserve the research notes as historical documentation.
- Remove unused SFTP transfer and editor IPC endpoints, the unused desktop log
  export endpoint and its unread buffer, obsolete types, helpers and transfer CSS.
  Planned SFTP transfers and editor cleanup remain in place.
- Drop the direct `ws`, `@types/ws` and `@electron-toolkit/preload` dependencies.

## 0.12.1

### Fixed

- **A folder untied from its repository kept showing its hosts.** Clearing
  “Mirror an inventory from a git repository” deletes the mirrored tree, and the
  local settings and passwords kept for those hosts with it — that much the
  dialog promises and the main process does. The window was never told: it holds
  its own copy of the tree, read once when it opened, and saving a group made it
  look no further than the group. So the hosts went on being drawn in the tree,
  found by the host palette and opened, for machines the folder no longer had,
  until the application was next started. Deleting such a folder outright left
  the same copy behind.
- **The file panel could take the whole pane, and the pane stopped answering the
  mouse.** Its width is remembered per window and knows nothing of the pane it
  opens in, so a panel left wide in a full-width pane fills a pane half that size
  entirely — and with the terminal squeezed to nothing beside it, rows in the
  panel could no longer be selected or dragged. The remembered width is kept, and
  a terminal is now always left 200px to be. The terminal is also clipped to its
  own box, which it never was: xterm's screen element, canvases and accessibility
  tree carry pixel widths written when it was last measured, a terminal with no
  room in it is not measured again, and those layers stood spread across the
  panel beside them with only its background keeping them out of sight.

## 0.12.0

### Security

- **An export file was trusted to be what it claimed.** `importFromFile` parsed
  it, checked one field, and cast the rest to the shape it was assumed to have —
  so everything afterwards ran on values TypeScript had been told about rather
  than values anyone had looked at. Some of those values become paths: an
  inventory source id names its checkout directory, and a group id names a tree
  the application removes. An export is a file someone was sent. It is now
  walked field by field, it says where it went wrong, and an id that reaches the
  filesystem has to be one safe component — checked again at the two places that
  build a path out of one, the second of which deletes.
- **A remote server chose local file names.** Downloading a directory over SFTP
  joined each entry's name to the local directory, and the name is whatever the
  far end said — so `..`, an absolute path or a drive letter wrote outside the
  folder being downloaded into. Anything whose basename is not itself is now
  refused.
- **The build jobs held a token that could publish.** The release workflow asked
  for `contents: write` at the top, so all four jobs had it, including the three
  that install npm packages and compile third-party C — which is exactly where a
  supply-chain problem lands, and a write token in that process is one an
  install script can reach. Only the job that creates the release has it now.

### Fixed

- **No desktop pane had ever opened on Windows.** Every connection failed with
  "The DNS host name was not found." for a host the machine resolves perfectly
  well, and would have failed the same way for a bare IP address. On Windows a
  process must call `WSAStartup` before it may use a socket, and until it does
  every socket call returns `WSANOTINITIALISED` whatever it was asked; the first
  such call is the name lookup, whose empty result FreeRDP reports as a DNS
  failure. libfreerdp does not start Winsock for you — every FreeRDP client and
  server that runs on Windows does it itself — and the desktop client here was
  written on a Mac, where nothing has to be started.
- **A remark from the host closed the session it was describing.** A Logon Error
  Info PDU is named for its worst case and is usually not one:
  `LOGON_MSG_SESSION_CONTINUE` with a session id is what a host that keeps
  disconnected sessions sends on putting you back into yours. The pane took
  every one of them for a failure, and a failure stops the session — at logon,
  before the first frame, every time, which made such a host unreachable. The
  codes now travel with the message, and only a refusal is one.

### Changed

- **The release contract now looks inside the package.** It could say a disk
  image existed and that every name in `latest*.yml` resolved to a file; it
  could say nothing about what was in the disk image. The desktop client and the
  libraries it loads travel through an `extraResources` filter, and a filter
  that quietly stops matching produces a build that installs, launches and
  cannot open a single pane. Each runner now reads its own unpacked application:
  the client is there, non-empty and executable, its libraries are beside it,
  `ShadowHost.exe` came along on Windows — and the SDL clients, the FreeRDP
  developer tools, `vcpkg` and `shadowprobe` did not.

## 0.11.1

### Changed

- **A release now has a contract, and something other than memory checks it.**
  Four days of releases produced one drafted twice with its artifacts split
  between the halves, one whose Windows installer was named differently from
  what `latest.yml` asked for — a silent 404 for every update — and one whose
  macOS bundle carried no signature at all, which Apple Silicon calls a damaged
  download. All three were green: none of it is a compile error or a failing
  test, it is a set of agreements between files that nothing was comparing.
  `npm run verify:release` compares them, on every push and again at three
  points during a release: the sources before the build, the macOS bundle before
  it is wrapped in a disk image, and the assembled payload before the draft is
  created. The idea is borrowed from KubeDeck, which keeps the same kind of
  contract beside its own build.

## 0.11.0

### Security

- **A lock now stops the application, not only the view of it.** Locking covered
  the workspace with an opaque overlay and left everything under it mounted,
  listening and connected: two presses of Tab out of the password field walked
  the focus into the interface behind, where tabs could be switched, the snippet
  palette opened, and a terminal typed into that nobody could see. The overlay
  stopped a mouse and nothing else. The background is now `inert` — beyond reach
  of the keyboard as well — and the main process refuses to start anything while
  the vault is shut: no SSH session, no desktop, no file listing over SFTP. That
  half matters on its own, because a host that signs in with a key or through
  the agent never asks the vault for anything, so nothing at all stood between a
  locked application and those machines. What is already running is left alone:
  locking is not disconnecting, and an edit saved after the lock still uploads.

- **Changing the master password can no longer lose a secret or reopen the
  vault.** Deriving a key is deliberately slow and runs off the main thread, so
  the application keeps going while it happens — and the re-encryption worked
  from a copy of the secrets taken before that wait, then wrote the whole file.
  A password saved in between was overwritten by a file that predated it, with
  nothing left to recover it from. In the same window the idle timer could lock
  the vault, and finishing anyway put the new key back into it: the window went
  on showing its lock screen while the main process was open again. The state is
  now re-checked after every wait, the secrets are read at the moment they are
  re-encrypted, and two changes at once are serialised rather than overwriting
  one another.

### Fixed

- **A fragmented SOCKS request no longer kills the application.** The handshake
  of a dynamic port forward was read with one `data` event per message, which is
  not something TCP promises: a request split across two segments left the
  parser reading a port past the end of the buffer, and a `RangeError` thrown
  inside a socket handler is an uncaught exception in the main process — every
  open session goes with it. The handshake is now accumulated and parsed only
  when complete, with tests that feed it a byte at a time. Two quieter faults
  went with it: bytes sent behind the request were dropped, so a client that
  does not wait for the reply lost the first thing it said, and a handshake that
  never finished held its socket for as long as the application ran.

- **Temporary copies of remote files are removed at quit.** Every file opened
  for editing is downloaded in the clear, and the clean-up walked the list of
  live edit sessions — but a session is dropped the moment its connection
  closes, which for most files is long before the application exits. The copies
  of everything edited over a connection that had since been closed stayed on
  disk. The directories are now tracked in their own right.

- **Resetting the terminal settings resets the terminal settings.** The button
  handed over every default there is, so it also put the interface back into
  another language, forgot the external editor and moved the idle lock back to
  fifteen minutes — three settings on other tabs, none of them named on the
  button.

### Changed

- **The vault screens speak Russian too.** Creating and unlocking the vault were
  the last screens written only in English, which made the lock screen — the one
  screen every user sees — the least translated thing in the application. The
  two buttons above the tree went with them.

## 0.10.2

### Fixed

- **Ctrl belongs to the shell on Windows and Linux too.** The application's
  shortcuts sat on plain `Ctrl` there, which took the keys a terminal exists to
  deliver: `Ctrl+D` split the pane instead of ending the session, and `Ctrl+W`,
  `Ctrl+K`, `Ctrl+L`, `Ctrl+P` and `Ctrl+F` never reached the far end either.
  The comment above that code said this had been dealt with — it had, on a Mac
  alone, where `⌘` gave somewhere else to put them. Off a Mac they now sit on
  `Ctrl+Shift`, which is where Windows Terminal and MobaXterm put theirs, for
  this reason. Two exceptions, both deliberate: `Ctrl+1 … Ctrl+9` still jump
  between tabs, since no shell has ever wanted them, and splitting downwards is
  `Ctrl+Shift+E`, because `Shift` is part of the modifier there and cannot also
  choose the direction. The hints in the interface say the combination that
  works rather than translating `⌘` to `Ctrl`.

### Changed

- **A refused login now says which machine refused, as whom, and with what.**
  ssh2 answers "All configured authentication methods failed" and nothing else,
  which through a jump host does not even say which end refused — and the answer
  matters, because each machine in a chain authenticates separately with its own
  settings. Passing through a bastion does not sign you in to the far host as
  whoever you are on the bastion; the far host is offered whatever the app has
  for it, and a blank field there means the group's password, silently. The
  error now names the host, the login and where that credential came from — and,
  when the server said so during the handshake, the ways of signing in it is
  actually prepared to accept. That last part separates the two causes that look
  identical from this end: a password that is wrong, and a server that never
  wanted a password at all. Only the second is worth changing settings over, and
  nothing here could tell them apart before.

## 0.10.1

### Changed

- **The tree has been through Prettier, and CI keeps it that way.** Eighty-six
  files were formatted in a commit of its own — nothing but whitespace, so it
  can be skipped whole in `git blame` — and `format:check` joins the checks
  that already run on every push. It was left out until now for exactly this
  reason: it would have failed on files nobody had touched.

- **The drop-zone arithmetic is out of the tree and under test.** Which part of
  a row means "sort me here" and which means "put this inside me" is four lines
  of arithmetic that decided the feel of every drag, and it sat in a
  thousand-line component where nothing could reach it. It is now a module of
  its own with tests for each third of a row.

### Security

- **The window's preload runs sandboxed.** The interface draws other people's
  data — terminal output, file names over SFTP, an inventory out of somebody's
  repository — and it draws it in Chromium. Should any of that ever manage to
  run code inside the page, the sandbox is the difference between a compromised
  tab and a compromised machine: without it the preload sits beside that page
  with Node in hand, able to read any file and start any program. It cost two
  small moves — the account name and the clipboard are now asked of the main
  process, synchronously, so no caller changed.

- **The window refuses to navigate anywhere.** Opening a new window was already
  refused; navigating this one was not, and every power the page holds — the
  vault, SSH, the file system through SFTP — is reachable through a bridge that
  cannot tell one page from another. Nothing in the interface navigates, so
  anything that tries is not us. A webview is refused for the same reason.

- **No stored password crosses into the window any more.** The channel that
  answered "who does this host sign in as" returned the password along with the
  name, from the days when the client authenticated in the window. The client
  moved into the main process; the pane went on calling this and went on using
  exactly one bit of the answer — whether the password was empty — so the secret
  made the crossing for nobody. It now answers with that bit. It was the only
  place a stored secret left the main process.

## 0.10.0

### Added

- **Folders can be sorted by hand, as hosts already could.** Dragging a folder
  could only put it inside another one; there was no way to say which of two
  folders comes first, and the order was the order they happened to be created
  in. A folder now lands in the gap when it is dropped on the top or bottom
  quarter of a row, and inside when it is dropped on the middle — so the drop
  the tree has always had keeps half the row, and aiming is not required for
  either. The order is stored the same way the hosts' order always has been.

### Fixed

- **A release is assembled once, by one job, instead of by three runners at
  the same time.** electron-builder uploaded straight from each runner and
  looked the release up by tag — and a draft release has no published tag, so
  the lookup answers 404 for a release that plainly exists. Every publish that
  asked was told there was none, and made one. It was never a race between the
  runners: v0.9.1 was built one runner at a time and still came out as two
  drafts, with a disk image in one of them and its blockmap in the other,
  because a single runner publishes several groups of artifacts at once and each
  asked the same question. Whether a release came out whole was down to timing,
  and every release before this one was lucky. Now nothing publishes until
  everything is built, and one job creates the draft with one command — which
  also means a manual run leaves the packages on the run itself, so a build can
  be tested without a tag.

- **The Windows installer is named without spaces, so the updater can find
  it.** Its default name is `TerminalDeck Setup 0.9.1.exe`, and electron-builder
  writes the hyphenated form into `latest.yml` while renaming the file to match
  as it uploads. Uploading with `gh` instead sends the name from disk, and
  GitHub turns the spaces into dots — so the updater asked for
  `TerminalDeck-Setup-0.9.1.exe` and the release held
  `TerminalDeck.Setup.0.9.1.exe`. Every Windows update would have failed on a
  404, and failed silently, since the window says nothing about a failed update.
  The name is now stated with hyphens where the file is built, and cannot
  drift.

## 0.9.1

### Fixed

- **Syncing a folder no longer fails on Windows with `EPERM, Permission
  denied`.** A folder that had synced under 0.8.0 kept a clone of its own, and
  0.9.0 deletes that on the first sync now that checkouts are shared. Git marks
  everything under `.git/objects` read-only, and on Windows a read-only file
  cannot be unlinked at all — `force: true` forgives a file that is missing, not
  one that refuses to go — so the deletion threw, and threw *after* the
  repository had been cloned and read successfully. The user was shown a
  permission error in place of the inventory they had asked for, by a step that
  exists only to reclaim disk space. The attribute is now cleared first, and
  more to the point the tidying up can no longer fail the sync: it is
  housekeeping, and the worst it can now cost is a directory nobody reclaims.

## 0.9.0

### Added

- **A repository is remembered, and folders share it.** Pointing a folder at an
  inventory once puts that repository in a list, and every folder made
  afterwards can be pointed at it without the address being typed again — with
  paths of its own, which is the point: one inventory holds production in one
  file and staging in another, and each wants a folder. Folders that agree on
  the address and the branch now share a single working copy, where before each
  cloned the whole repository for itself; the clone is removed when the last
  folder reading it goes, and the saved repository stays, since it is there to
  be chosen again.

### Fixed

- **The macOS download is no longer reported as damaged.** electron-builder
  skips signing entirely when no certificate is configured, and on Apple Silicon
  the kernel will not run an executable that carries no signature at all — so
  the DMG downloaded from a release opened onto *"TerminalDeck is damaged and
  can't be opened. You should move it to the Trash."* The disk image was fine;
  the application inside it was unsigned. The build now signs the bundle ad-hoc
  when there is no certificate, which is all a free build can do for itself:
  Gatekeeper still asks, but it asks the ordinary question with **Open Anyway**
  behind it instead of telling people to throw a working download away. The hook
  stands aside the moment a real certificate is configured. macOS auto-update
  still needs a Developer ID signature and still will not work without one.

- **A stuck Ctrl is now cleared by the mouse as well as by the keyboard.** The
  repair added in 0.7.2 runs on the next keystroke, which is fine until the
  next thing you do is click — and on a desktop that is most of what you do.
  Every click until you happened to type was a Ctrl-click: selecting instead of
  opening, dragging a copy instead of moving. A mouse event answers
  `getModifierState` exactly as a key event does, so the same reconciliation now
  runs from the mouse, and a modifier nobody is holding survives at most one
  click.

- **⌘ as Ctrl and the repair no longer contradict each other.** With the
  substitution on, a held ⌘ is a held Ctrl on the far side while
  `getModifierState('Control')` is false here — so the check added in 0.7.2
  released the Ctrl that ⌘ had just pressed, and ⌘C arrived over there as a bare
  `c`. The reconciliation now reads the modifiers the way the substitution sends
  them, and letting go of ⌘ while the real Ctrl is still held no longer releases
  Ctrl on the far machine.

- **A full-screen session finally takes part in any of this.** While a desktop
  is full screen the main process takes every combination before the window sees
  it, and hands on only the letter — so the letter of every `Ctrl+C` and
  `Ctrl+V` never reached the code that keeps the two ends' modifiers in step,
  and the only key events the session saw were the modifiers themselves. The
  repair was therefore close to dead in the one mode a remote desktop is
  actually used in. A forwarded key now carries the modifiers that were down
  when it was taken, and the session reconciles from those before sending it: a
  Ctrl held over there and nowhere else is released by the very next `Ctrl+C`,
  and one released too early is pressed again so that `Ctrl+C` is not delivered
  as a bare `c`.

- **A modifier held through a `blur` is pressed again rather than only
  released.** Coming back to a session with a finger still on Ctrl left this end
  holding it and the far end not, so the first Ctrl-click after switching
  windows was a plain click. The repair now works in both directions.

## 0.8.0

### Added

- **A folder on the Sessions tab can be tied to a git repository.** Edit any
  folder, give it a repository holding an Ansible inventory, and its hosts stand
  in the tree beside the ones saved by hand — in the same folder, which can go
  on holding your own sessions and subfolders too.

  Two things separate this from the Inventory tab. The first is *when the
  network is touched*: what a sync took is written to disk, so the folder shows
  its hosts on the first frame after the window opens and never fetches on its
  own — syncing is **Sync with git…** on the folder, or the ⟳ on its row. The
  Inventory tab kept its parsed tree in memory only, which is why it was empty
  after every launch until somebody pressed sync.

  The second is *what a sync takes*. Every sync asks, before anything on disk
  changes: the previous choice is ticked, groups that appeared since last time
  arrive ticked and marked new, a subgroup unticked on purpose stays unticked,
  and ticking a group takes its subgroups. A sync then brings the folder to what
  the repository says now — what has left the repository leaves the folder, and
  the dialog says what is about to go, including how many of those hosts hold
  local settings, since those and any password saved for them go with them.

  The hosts land in the folder as one flat list, however deeply the inventory
  nests them, and a host named by three groups appears once rather than three
  times. The repository's groups are still read and still kept — they are where
  a host's settings and `group_vars` come from — but they are not drawn as
  folders of their own: an inventory nests for reasons that have to do with
  playbooks rather than with looking a machine up.

  Read-only, like the Inventory tab: nothing is ever pushed. Local settings on a
  mirrored host or group are kept outside the repository and re-applied after
  every sync, and a backup carries the repository, the branch and the chosen
  groups rather than the mirrored tree.

### Fixed

- **A repository whose address was edited is no longer synced from the old
  one.** A checkout is keyed by the source rather than by its address, and
  `git fetch origin` asks the working copy where origin is — which nothing had
  ever told that the answer had changed. Editing the URL of an inventory that
  had been cloned once went on fetching the previous repository for ever, and
  reported success each time: the hosts simply stayed as they were. The remote
  is now re-pointed when it differs.

- **The help says which key reaches the far side on a Mac.** It said "Alt+Tab",
  which on a Mac is read as the app switcher — and the app switcher is `⌘Tab`,
  which macOS takes below the level any application can reach, so it is the one
  key that cannot work. `⌥Tab` is reserved for nothing there and arrives on the
  far machine as exactly the Alt+Tab Windows is waiting for. Cost an afternoon
  of looking for a fault in the forwarding.

## 0.7.2

### Fixed

- **A modifier is never left held on the far machine.** The session forwards
  `Ctrl down` as a scancode and forwards `Ctrl up` only while the focus is
  still inside it — so a focus that moves between the press and the release
  leaves the far end holding a key nobody is holding, for every application
  over there. Pressing Ctrl once cleared it, which is a fresh pair of events
  putting the two sides back in step by hand.

  Found the hard way, and only because of what it was being tested on: a
  desktop running this very application, where a `k` typed into a form opened
  the snippet palette. On anything else it would have read as the far machine
  misbehaving.

  Losing the release is not exotic — this application moves the focus itself,
  since its own palettes take it the moment they open. So rather than trying
  not to lose one, every keystroke now carries the true state of every
  modifier and puts the far end back in step. The next key pressed after a loss
  repairs it, which is the same repair people were making by hand, without
  their having to know it was needed.

- **An inventory's groups are read, not just `all`.** A YAML inventory is a
  mapping of group name to group, and `all` is only the one Ansible gives a
  meaning to. The parser read `all`, stopped, and threw the rest away.

  That is not an exotic layout — writing the groups as siblings of `all` rather
  than nesting them under `all.children` is the ordinary shape of a Kubernetes
  inventory, and it fails quietly: the hosts are listed under `all.hosts` as
  well, so they all appeared, under `ALL`, and the repository looked like one
  with no groups in it.

  Every top-level key is now a group, placed under `all` the way Ansible places
  it. Two things follow that were missing with them: a host is shown under each
  group that names it, and a group's own `vars` — and its file in `group_vars/`
  — reach the hosts inside it, which is usually where the login lives.

- **Shortcuts stay out of a field being typed into.** Every one of them is a
  modifier and a single letter, and they fired wherever the focus was — so a
  group being named could lose its dialog to `w`, or have the snippet palette
  open over it on `k`. Reported exactly that way, with the palette sitting on
  top of a half-filled repository dialog.

  The terminal stays as it was, and has to: xterm types into a textarea of its
  own, and opening a tab or the palette from a shell is what these are for.

  A combination that also holds Alt is left alone too. AltGr is Ctrl+Alt on
  Windows and Linux — it is how a keyboard makes a character rather than a
  command, and nothing here wants Alt in the first place.

- **A full-screen session takes the keyboard it was given.** Going full screen
  locks Alt+Tab, Escape and the ⌘ keys away from the local system so they can
  reach the far machine instead. They were not reaching it: the session's key
  handler ignores anything arriving while the focus is outside it, and full
  screen is entered from a button on the pane's toolbar — which leaves the
  focus on that button, and the toolbar is not rendered in full screen, so the
  focus fell to the body.

  So the keys were taken from one machine and delivered to neither. Alt+Tab
  showed it first, because the lock had just made this its only route; copy and
  paste went the same way, and came back after switching windows and clicking
  the picture, which is what put the focus back by hand.

  Alt+Tab still does not switch local windows while a session is full screen —
  that is the point of the lock, and F11 or holding Escape is the way out.

## 0.7.1

Three things that took the mouse away from a full-screen desktop, reported as
one: a corner of the far machine that had stopped responding. The first is the
one that was actually doing it.

### Fixed

- **The top-left corner of a full-screen session takes clicks again.** A strip
  there swallowed them — invisible, about as wide as the host list and some
  twenty-eight points tall — and what it swallowed never reached the far
  machine at all.

  It was the sidebar's window-drag region: the piece of empty space at the top
  of the host list that exists so a window with no title bar of its own can
  still be picked up and moved. A drag region is not a paint effect. It is
  computed from the layout and handed to the operating system, which takes the
  mouse over it before the page is told anything.

  Full screen is asked for on a *pane*, not on the window, so everything around
  that pane stops being drawn — and stays laid out. The sidebar was invisible
  and its drag region was not: it went on sitting at the top-left of the
  display, over the desktop, taking every click inside it. Invisible, because
  by then there was nothing left to see.

  It is not rendered at all while a pane is full screen now, rather than marked
  undraggable, so there is no region left to get the arithmetic of wrong.

- **Nothing of this application is left over a full-screen desktop.** A strip
  of pane toolbar could be brought back there by pressing the pointer against
  the top of the display and holding it. It is gone, and so is the strip: in
  full screen the toolbar is not hidden, it is not rendered at all.

  What it cost was worth more than it was. Every button on that strip carries a
  `title`, and a `title` is a native tooltip — a window of the operating system,
  drawn above everything on the screen and owned by no page. Sliding the strip
  out from under a pointer that has not moved is not the same as the pointer
  leaving it, and a tooltip that was up when the strip left did not reliably
  come down: it stayed at the top of the display, over whatever the user
  switched to next, swallowing every click inside it. Reported twice as "the
  top-left corner of the screen stopped working", in Outlook both times.

  The way out never went through that strip anyway — F11 leaves full screen and
  so does holding Escape, both stated in the help — so what is lost is a
  gesture, and what is gained is that the top edge of a full-screen session
  belongs entirely to the far side, which is where its own tab strip, menu bar
  and window buttons live.

- **The desktop's measured size is no longer a native tooltip.** It said what
  size was asked for and what the server gave back, and it was the `title` of
  the element covering the whole session — so it was displayed for as long as
  anyone worked in one, and it is the only title in this application whose text
  changes while it is on screen. Both halves of the same trap as above. It is a
  mark in the pane toolbar now, and what that opens is drawn inside the page.

## 0.7.0

### Added

- **Saved accounts, and a way to reach a host as somebody else.** Settings →
  Accounts keeps logins that belong to no host and to no group: a name, a
  username, and a password, a key file or the agent. Right-click any host —
  saved or from an inventory — and "Connect as…" lists them.

  What makes this worth having is what it deliberately does *not* do. It writes
  nothing back. The host keeps the login it is saved with, every other
  connection to it is unaffected, and there is nothing to undo afterwards —
  which is the whole failure mode of the alternative, where a host is edited for
  one connection and quietly keeps the administrator's login for the next
  fortnight. The choice rides on the pane instead, so reconnecting signs in as
  the same account again and the pane is named after it, because a window signed
  in as somebody else is otherwise indistinguishable from one that is not.

  Only *who you are* is replaced: the port, the jump host, the on-connect
  commands and the RD Gateway stay the host's own. Two consequences were decided
  rather than fallen into. A gateway configured to use the host's credentials is
  offered the chosen account, since that is what "my connection credentials" now
  means for this session. The jump hosts on the way are not — a bastion is
  reached as whoever it is configured to be reached as, and offering a domain
  administrator to every hop would mostly fail and occasionally lock the account
  out.

  An account with no password saved is a supported arrangement, not a
  half-finished one: the name and the login are remembered and the password is
  asked for each time. That case is also why the four fields are replaced
  together rather than layered onto the host's own settings — layering would let
  an account with no password fall back to the host's, offering one account's
  name with another account's password, which fails as "permission denied" and
  gives nothing to look at that says why.

  Works for desktops as well as shells. Passwords live in the vault exactly as a
  host's do, `credentials.json` holds nothing but names and references, and
  accounts travel with a backup export — their passwords only when credentials
  are included in it.

- **"Connect several times…"**, in the same menu: one host, as many windows as
  you ask for, under whichever account you pick, opened as separate tabs, tiled
  into one tab, or in a workspace of their own. Each is a connection of its own
  and is numbered so they can be told apart. Twenty at once is the cap — every
  one of them is a real shell and a real authentication attempt on the far end,
  and a mistyped three hundred against a host that locks an account after five
  failures is a bad afternoon.

### Fixed

- **A key pressed at a full-screen remote desktop now reaches that desktop.**
  Ctrl+W closed the tab the session was sitting in instead of closing a window
  on the far machine — a keystroke aimed at one computer landing on another, and
  every other shortcut behaved the same way. The window's own handlers run in
  the capture phase, ahead of the session, and knew nothing about full screen.

  There were two layers to this and only the first was obvious. Beyond the
  window's shortcuts sit the application menu's accelerators, which never reach
  the window at all: on a Mac ⌘W is Close Window, ⌘R reloads and ⌘Q quits. Those
  are taken in the main process now — the one place early enough — and handed to
  the session over a channel of their own, which is the same route the zoom keys
  have always had to take.

  Nothing is reserved while a desktop is full screen, deliberately: an exception
  list is how the surprise comes back. The two ways out are not shortcuts and
  are unaffected — F11 is handled by the session before it forwards anything,
  and holding Escape is the browser releasing the locked keyboard. A modifier
  key itself is never taken, or the far end would learn about the `W` and not
  about the Ctrl in front of it; nor is anything with Alt held, since the window
  turns Ctrl+Alt+End into the far side's Ctrl+Alt+Del and cannot do that for a
  key it never sees. In a window rather than full screen nothing changes.

- **The help and the README said ⌘ shortcuts already stood down over a focused
  desktop while "send ⌘ as Ctrl" was on.** They did not; nothing in the code
  ever did that. Both now describe what happens, which is that full screen hands
  the keyboard over and a window does not.

- **The line that sets up directory tracking no longer appears on screen.**
  Connecting to a host with "follow the terminal's directory" on left three
  hundred characters of shell nobody typed sitting above the first prompt —
  `__td7(){ printf '\033]7;...`. There is a whole class whose only job is to
  take that back out of the stream, and it was matching the bytes exactly and
  contiguously.

  They are not contiguous. The echo is not the pty copying input back: it is
  the shell's line editor drawing it, and a line longer than the pane is drawn
  across several rows with bytes of the editor's own at each wrap — a space and
  a carriage return at the right margin, sometimes a cursor move. At three
  hundred characters the setup line wraps in any ordinary pane, so the search
  found nothing and the suppressor sat there suppressing nothing. Every one of
  its eight tests fed it a single unbroken line.

  It now walks the two in step and skips what a redraw is entitled to insert,
  taking an exact byte as itself first so a space in the echo is matched rather
  than swallowed as padding. Anything else — an ordinary character where the
  echo has a different one — still fails the match, and a screenful with no
  echo in it is still released rather than held.

- **A context menu replaced by another one in the same place is measured
  again.** The nudge that keeps a menu inside the window is taken from its
  height, and it was taken once; a second menu opening where the first stood —
  which is what choosing "Connect as…" does — was placed by the arithmetic done
  for the menu it replaced, and near the bottom of the screen that put half of
  it off the edge.

## 0.6.0

Numbered as a minor release rather than the patch it started as. It began with
three small things and grew six features while it went: a question mark beside
every explanation, panels that can be dragged, a settings tab of its own for the
language, a searchable trusted-key list, a configurable lock delay, and five
parts of the application that its own help had never mentioned. A patch fixes;
this also adds.

### Added

- **The language is on a tab of its own** rather than floating above them all.
  It sat in the dialog's header, which put it on every tab — a setting somebody
  changes once, permanently in front of the ones they came to change. Settings →
  General holds it, and whatever else turns out to be about the application
  rather than about terminals, files, security or backups.
- **The trusted host keys are behind a button rather than on the page.** They
  were drawn as a row apiece, which reads as a list until somebody has three
  thousand of them — and then it is neither a list nor a settings screen. What
  the screen shows now is a count and "Review…", and what that opens is a filter
  with the first twenty matches. Nobody scrolls three thousand rows to find one;
  finding one was always a search, and it is one worth opening only when a
  server has been rebuilt.
- **Five things the application does were missing from its own help**: agent
  forwarding, jump hosts, session logging, port forwarding and the monitoring
  strip — two of them whole panels with a toolbar button each. The shortcut and
  feature list now covers them, including what agent forwarding costs: the key
  never travels, and root on the host you forwarded to can use it for as long as
  you are there.
- **The host list can be dragged wider**, and stays where it is left. It was
  fixed at 260 pixels, which is not enough for a repository whose groups nest
  four deep — the tree simply ran out of room. Its width is remembered in this
  window rather than in the settings file: how wide a panel should be is a
  property of the screen somebody is sitting at, not of a configuration they
  would carry to another machine. The file panel already worked this way, and
  the two now share one implementation of the drag.
- **The explanations moved into a question mark beside what they explain.** The
  dialogs here explain themselves at length, and the explanations are worth
  having — but read once. Left on the page they push the controls apart until a
  dialog with six settings needs scrolling and the settings are hard to find
  among the prose about them. Hovering the mark shows the text, and so does
  focusing it with the keyboard: a description reachable only by pointer is one
  that some people cannot read at all.

  What stayed on the page: anything that reports a state rather than describing
  a control — "Reading both sides…", "No hosts trusted yet" — and the warnings
  about the operation in front of you, which are the last things that should be
  hidden behind a hover.
- **The idle lock delay is a setting**, in Settings → Security: never, or from a
  minute to a working day, fifteen as before. The right answer is a property of the
  room rather than of the application — fifteen minutes is impatient for someone
  reading a build log on a machine nobody else can reach, and generous for a
  laptop on a desk in an open office.

### Notes

- **A release can be built again.** Packaging began refusing to continue without
  the desktop client, which is right — a release without it has a desktop pane
  that cannot open — and nothing built one on the runners, so a tag produced a
  Linux artifact and two failures. Each runner compiles it for itself now, cached
  on the FreeRDP version so only the first run pays the half hour.

  macOS ships Apple Silicon only and Windows x64 only while that holds: the
  client is built by the runner that packages it, and those are what the runners
  are. The other two architectures need a second job apiece.

- **The Windows client builds, and the script names no version.** Getting there
  took five failures, of which two were a version written into a file: a
  generator asking for "Visual Studio 17 2022" on a runner that had moved to
  Visual Studio 18, where CMake replies that it can find no Visual Studio at all
  — beside a vcpkg that had just built every dependency with that same compiler
  — and a Visual C++ runtime copied from an older toolset's redistributable than
  the one doing the compiling, which is the single direction that is not allowed
  to work and fails only on a machine with no Visual Studio, the machine a
  portable build is for. vswhere now says which is installed, CMake's own list of
  generators gives the matching name, and the runtime comes from the newest
  redistributable. The other three: a UTF-8 BOM, without which PowerShell 5.1
  reads em-dashes as Windows-1252; CMake defaulting to a runner's MinGW gcc; and
  a cache that handed back the very files a fix had just replaced.

  The Windows package now carries the client, FreeRDP, OpenSSL, the codecs and
  the runtime. It has not yet opened a desktop pane on Windows: the build is
  proven, the session is not.


### Fixed

- **Every download on Windows made a directory beside the file.** Working out
  where to put a file searched its destination for the last `/`. A local path on
  Windows holds no forward slash at all, so the search failed, the last character
  was taken off the file name, and `a.txt` arrived next to a directory called
  `a.tx`. It went unnoticed because that call is recursive and made the real
  parent on the way past — and would have stopped being merely untidy at the
  first path holding a forward slash earlier on, where the directory made is the
  wrong one and the file has nowhere to land. Found by the Windows job on its
  first run that got far enough to run the tests, which is what it is for.

- **A shadow viewer could outlive the application.** `ShadowHost.exe` holds an
  mstsc window open and exits when its input pipe closes — but only when it next
  looks, and one waiting on the far end may not look for a while. The method
  that stops them all existed and was called from nowhere, as did the one for
  the monitoring pollers. Both are attached to quit now.
- **The transfer dialog and the transfer disagreed about what silence means.**
  `defaultDecisions` fills every conflict with "skip" and says in a comment that
  skipping is the default; the dialog shows "skip" for anything undecided. The
  code that actually moves the files read that same silence as permission to
  overwrite. Three places, two answers, and the one that ran was the
  destructive one — so a conflict whose answer went missing was destroyed while
  both of the others claimed it had been left alone. An explicit answer is still
  obeyed either way; silence over a path the plan named as a conflict now means
  leave it.
- **An interrupted download destroyed the file it was meant to replace.** It
  wrote straight into the destination, so a connection dropping halfway left a
  truncated file where a whole one had been — the fetch that was meant to bring
  a copy having ruined the copy already there. Downloads now land under another
  name and are moved onto the destination when they are complete.

  Uploads deliberately still write straight into place. Through a temporary name
  the new file would carry this application's ownership and default permissions
  rather than those of the file it replaces — quietly changing the mode of a
  server's configuration file is a larger accident than a transfer that fails —
  and SSH_FXP_RENAME is not POSIX rename: most servers refuse it when the
  destination exists, so overwriting would depend on an OpenSSH extension that
  is not everywhere.
- **Copies of remote files opened for editing were never deleted.** Each one is
  downloaded into a temporary directory of its own, and they stayed there — a
  remote `sshd_config`, or anything else worth editing over SSH, left in plain
  text under the system's temporary directory. Cleared at quit, which is the
  point after which there is nothing left to upload them to; the editor is
  somebody else's program and this end cannot tell when a file is finished with
  before then.
- **Agent forwarding only worked for hosts that signed in with the agent.** How
  you prove who you are and whether your agent travels with you are two
  questions, and OpenSSH treats them as two — `ForwardAgent yes` applies whether
  you typed a password or offered a key. This end answered both at once: the
  flag was attached to the agent branch alone, so a host set to password or key
  authentication showed the checkbox, remembered what was ticked, and forwarded
  nothing. It now applies whatever the login method, and asks for nothing when
  there is no agent to forward.
- **A file saved twice while the first save was still going up lost the second
  one.** The watcher returned early whenever an upload was in flight and nothing
  looked again afterwards, so over a slow link the editor said saved, the far
  end kept the older file, and neither side said a word. A save that arrives
  during an upload is now remembered and sent when that one finishes.
- **Three of the six files this application keeps were written unsafely**, and
  which three was an accident of who wrote them. Sessions, known host keys and
  trusted certificates were written in place; the vault, collections and
  snippets went through a temporary file and a rename. The careful three are the
  ones written least. All six read the same way now, through one place that
  states the rule — so the next store added gets it without having to know it
  exists.

  For the two security stores the cost was not only tidiness: a truncated
  `known_hosts.json` is an application that has forgotten which key it trusted,
  and the next connection to that host is treated as a first meeting.
- **A damaged file was read as an empty one, silently, in five of the six.**
  What that shows is an application with nothing in it — no hosts, no snippets,
  no remembered keys — which reads as "everything is gone", and the first save
  after that writes the emptiness over what was left. Damaged files are moved
  aside under a name of their own now.

  The file that made this worth chasing is `sessions.json` — every host, group
  and setting, rewritten on each edit and each drag, and the only one of the six
  written that often. Both halves are covered by tests that fail without the
  fix.
- **A desktop pane could read past the end of its own picture.** The rectangle
  of what changed is clamped against the framebuffer as it was when the
  rectangle was noted, and `gdi_resize` — on another thread — frees that buffer
  for a smaller one. The gap was two lock acquisitions wide. It is now cleared
  under the same lock that swaps the buffer, and clamped again at the moment it
  is read.
- **Whole screens were untranslated without the phrase-book test noticing.** It
  read only `t('…')` written with single quotes, which is precisely the wrong
  half: a string containing an apostrophe has to be written with double quotes,
  so `the host's own login` and its like were invisible to the one test meant to
  catch them — sixty-two calls across four files. It also could not see the help
  dialog, which keeps its hundred and thirty-three phrases as data and renders
  them through a variable. Both are read now, and a third test watches the other
  direction: thirteen entries had outlived the desktop client they were written
  for.
- **The sidebar and pane toolbar were partly in English** whatever the language —
  Sessions, Inventory, Quick connect…, Snippets, SFTP, Monitor, Broadcast, and
  every tooltip built through `keyHint`, which rewrote ⌘ for other platforms but
  never asked for a translation. The phrase book had Russian for several of them
  already, waiting for a call that was never made.
- **The reconnect button did not always take the click.** The panel that offers
  it is laid over the terminal and said nothing about its own place in the
  stack, so which of it and xterm's own positioned layers ended up on top was
  left to chance. Its label was also the one string in the interface that was
  never translated.
- **A private key could not be found in the dialog asking for one.** Every SSH
  key lives in a directory whose name begins with a dot — `~/.ssh` for the ones
  people make, `~/.colima` and friends for the ones tools make — and a macOS
  open panel hides those. The panel now starts in `~/.ssh` and shows hidden
  files.
- **Ctrl belongs to the shell again on macOS.** Shortcuts were bound to ⌘ *or*
  Ctrl, which quietly took nearly every readline key with them: Ctrl+D ends a
  session, Ctrl+K kills to the end of the line, Ctrl+W deletes a word, Ctrl+L
  clears the screen and Ctrl+P walks back through history — and each one was
  being turned into split, snippets, lock or a tab switch instead of reaching
  the far end. The application's modifier on a Mac is ⌘ and nothing else.

  The terminal had a second helping of the same fault: Ctrl+F opened the
  scrollback search, which is readline's "one character forward". Search is ⌘F
  on a Mac now.

  The same conflict stands on Windows and Linux, where Ctrl is the only
  modifier an application can reasonably claim. Moving those bindings is a
  separate decision with no free answer — Ctrl+Shift collides with the shift
  variants this app already uses, and Ctrl+Alt is AltGr on half the layouts in
  Europe — so they are left as they are rather than changed untested.

## 0.5.0

The desktop pane was rebuilt on a different client. Everything else here had
accumulated since 0.4.0.

### Added

- **The desktop is drawn by FreeRDP, in a process of its own.** The client that
  came before it ran as WebAssembly inside the window and had no graphics
  pipeline at all — not disabled, absent: no `Microsoft::Windows::RDS::Graphics`
  channel in its binary, no `h264`, `avc444` or `progressive` anywhere in it. So
  a host that could have sent video sent run-length-encoded bitmaps instead, and
  on one host 657 of 701 log lines were exactly that. What ships now is FreeRDP
  3.31, built from source into `td-rdp`, which negotiates the whole pipeline —
  H.264 in both AVC420 and AVC444, progressive RemoteFX, RemoteFX — and hands
  back the rectangles that changed as plain RGBA down a pipe. The pane puts them
  straight onto a canvas: nothing is re-encoded on the way and no pixel is
  converted, because the bytes the decoder produced are the bytes `ImageData`
  takes. At most one frame is ever in flight, so a busy window lowers the frame
  rate instead of growing a queue.
- **Sound from the far end**, switchable on a host or a whole group and on by
  default, as it is in every Windows client. It travels on its own channel and
  is played by the desktop client itself through the platform's own audio, so it
  costs this side nothing and the link something — worth turning off where the
  line should be spent on the picture.

- **A Russian interface**, chosen in Settings and applied at once. The English
  text is the key, so a screen with no translation yet shows English rather than
  machine names — a working screen, and visibly an untranslated one. Settings,
  the shortcut and feature list, the session tree, the tab strip, the pane
  toolbar, the session dialog and everything a desktop session shows are
  translated; the file browser, the group and inventory dialogs and the smaller
  panels are not yet.

- **Desktop settings on a host, a group and an inventory override**: the RD
  Gateway to reach a machine through, the resolution, and whether ⌘ is sent as
  Ctrl. They inherit along the same chain the login does, so a shared gateway is
  stated once on the group. The gateway's own password is resolved in the main
  process and never crosses into the window.
- **A desktop is drawn the size an ordinary monitor would give it.** Asking a
  Retina pane for the screen's own pixels made the picture sharp and half-size,
  because Windows lays out a 20-pixel menu the same way whether a pixel is a
  millimetre across or half of one. The size asked for is now divided by a
  magnification — by default the display's own density, so a Retina pane asks
  for exactly its points and draws every pixel as four, and an ordinary monitor
  asks for what it always did. The far end's own DPI is deliberately left alone:
  it is a setting of that machine, and a session someone else is logged on to
  would be resized under them. A host, a group or an inventory override can pin
  the percentage, 100% being every pixel the screen has.
- **One list, not a checkbox that greys out a percentage.** Stretching the picture on this
  side and asking the far end to lay itself out larger answer the same question, and offering
  both at once invited setting one and then disabling it with the other. They are still two
  settings underneath — they inherit separately — but a host is asked once.
- **A host may tell its session how dense this display is**, off by default.
  Magnifying the picture here gets the size right and costs sharpness, because
  a quarter of the pixels are being stretched over the pane; telling the far end
  instead has Windows lay itself out larger into every pixel the screen has,
  which is the same size drawn sharp — and, with the pixel budget at everything
  the screen has, a desktop drawn pixel for pixel. What travels is the factor
  actually asked for rather than the display's density, so a budget that cuts
  the request cuts the density with it and the desktop is the size of the pane
  either way. Off by default because it is the far end being asked to lay itself
  out differently: it is agreed per connection rather than written into the
  machine, and only a session of this app's own is ever told — a joined session
  is never resized at all. Windows 8.1 and Server 2012 R2 and later act on it.
- **No frame around a full-screen desktop, and no letterbox around the
  picture.** Two lines were left over the edges: the active pane's border, which
  says which pane has the keyboard and has nothing to say when there is one, and
  which — `box-sizing` being `border-box` — also took a point off each side, so
  the desktop was asked for two points less than the display in each direction.
  And an odd height, which a server is free to round itself, leaving a desktop a
  pixel taller than the pane and a bar along two edges. The height is now asked
  for even, the way the protocol already requires of the width.
- **The pane toolbar steps out of the way in full screen**, sliding back on a
  brush of the top edge. It was taking a strip about thirty points tall off the
  screen, and a desktop is asked for the size of its pane — so full screen asked
  for a size no monitor has, the one case where the picture cannot land pixel
  for pixel however the density is negotiated. F11 and holding Escape still
  leave without going near the edge.
- The picture is fitted **once the far end has delivered the size**, not at the
  moment it is asked for. Fitting is done against the last confirmed desktop
  size, so fitting at the moment of asking scales a new canvas by the old
  dimensions — which comes out the right height, the wrong width, and a band of
  empty pane down one side.
- **A desktop pane may now be smaller than the desktop in it.** A flex item
  defaults to `min-height: auto` and refuses to shrink below its content, and
  the content here is a canvas the size of the far end's desktop — so the box
  grew to the canvas rather than the pane, the client measured that box when
  scaling the picture to fit, concluded it already fitted, and the pane clipped
  it instead. The width had been given `min-width: 0` long ago; the height had
  not, and it did not matter until a desktop stopped being the size of its pane.
- **A desktop is scaled into its pane again.** The client re-applies its scale
  mode every time the far end confirms a new size, and reads that mode from a
  property — which this app set as an attribute, where it read as unset and
  matched no mode at all. The canvas was left at its natural size: a device
  pixel per desktop pixel, overflowing the pane and clipped rather than scaled,
  which is invisible for exactly as long as the desktop and the pane are the
  same size. They stopped being the same size when the size started following
  the screen.
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
- `TERMINALDECK_RDP_TRACE=1` runs the desktop client at FreeRDP's `DEBUG`, which
  names the codecs and channels it agreed on with the host. The log is kept in
  the main process — the last 400 lines per session — and written to
  `logs/desktop-<time>.log` only when asked, never printed: the client it
  replaced wrote several lines a frame into a console that held every one, and
  took the window to four gigabytes inside forty seconds.

### Changed

- **The tree has been through Prettier, and CI keeps it that way.** Eighty-six
  files were formatted in a commit of its own — nothing but whitespace, so it
  can be skipped whole in `git blame` — and `format:check` joins the checks
  that already run on every push. It was left out until now for exactly this
  reason: it would have failed on files nobody had touched.

- **The drop-zone arithmetic is out of the tree and under test.** Which part of
  a row means "sort me here" and which means "put this inside me" is four lines
  of arithmetic that decided the feel of every drag, and it sat in a
  thousand-line component where nothing could reach it. It is now a module of
  its own with tests for each third of a row.

### Security

- **Five doors were left open with nothing behind them.** The window could
  still ask the main process to reserve an address on the loopback gateway, to
  report why a session on it failed, to say what log level the embedded client
  should use, to write that client's log to disk — and to write arbitrary bytes
  into a folder of the window's choosing. All five served the WebAssembly client
  and the file transfer that went with it, both gone, and nothing had called any
  of them since. Removed, along with the resolver that read a gateway password
  out of the vault for the first of them.

  This removes the way in, not the gateway: `Gateway.ts`, `TsGateway.ts` and the
  [MS-TSGU] implementation under them are untouched and still tested. Whether to
  retire those is a decision of its own.
- **Only http and https are handed to the operating system** when something in
  the window asks to open a link. Nothing asks today — there are no anchors in
  the interface and the terminal does not turn output into links — so this
  guards a path that does not exist rather than one that does. It is here
  because of the cost if one appeared: `openExternal` gives the URL to the
  system, and `file://` opens whatever is registered for it while `smb://` on
  Windows offers the user's credentials to whoever is listening.
- **A repository address could be read by git as an instruction.** Inventory
  sources are cloned through the system git binary with an argument list rather
  than a shell, so there is nothing to escape — but git parses its own
  arguments, and an address beginning with a dash is not an address to it.
  `--upload-pack=<command>` in that position runs the command. Nobody would type
  that; the point is that the address does not have to be typed, since it also
  arrives through an imported backup or a configuration somebody else prepared.
  Addresses and branch names beginning with a dash are refused, and everything
  positional now travels after `--`.
- **An inventory path could read files outside its checkout.** The paths in a
  source are relative and read as such, and `join` walks out of a directory as
  happily as into it: `../../../etc` resolved cleanly, and whatever YAML was
  found there would have been parsed and presented as hosts. Reached the same
  way as the address above, and refused now.

- **Every dependency with an open advisory raised past it.** A Trivy scan of
  `package-lock.json` on 2026-08-25 found 50 — 2 critical, 21 high, 27 medium —
  and none of them is a flaw in this app's own code, so all 50 are answered by an
  upgrade:

  - **Electron 33 → 43** accounts for 27 of them. 43 is the newest major that
    needs no change here: Electron 44 removes the `clipboard` module from the
    renderer and preload processes, which is where this app reads and writes the
    clipboard, and moving that behind IPC is a change to make on its own rather
    than folded into a security bump.
  - **electron-builder 24 → 26** answers the two advisories against
    `app-builder-lib` and `builder-util-runtime` directly, and pulls `tar` from
    6.2.1 to 7.5.x, which is where the other twelve go — including one of the two
    criticals.
  - **electron-vite 2 → 5** with **Vite 5 → 7** replaces esbuild 0.21 and brings
    `postcss`'s own copy of `nanoid` past the flaw in 3.3.17. Vite is now named in
    `devDependencies`, because electron-vite 5 declares it a peer instead of
    depending on it.
  - **vitest 2 → 3** answers the second critical.
  - **ws 8.18.0 → 8.21.3** answers the only two that a running installation could
    meet rather than a build machine: `ws` carries the loopback WebSocket the RDP
    client talks to.
  - `extract-zip@2.0.1` was reported with no fixed version to move to. It arrived
    under Electron, which stopped depending on it in 42, so it leaves with the
    upgrade rather than being answered by one.

- **Node 22.12 is the floor now**, and `engines` says so. Electron 43, Vite 7 and
  electron-vite 5 each refuse to run on anything older; CI already builds on Node
  22.

- **`npm run dev` and `npm start` fetch the Electron binary before they start.**
  From Electron 42 the binary is no longer installed by a `postinstall` script —
  npm supply-chain hardening the Electron team did upstream — and is fetched on
  demand instead, by `require('electron')`. electron-vite does not go through
  that: it reads `node_modules/electron/path.txt` itself and fails with "Electron
  uninstall" when nothing has written one yet. So both scripts now run
  `install-electron` first, which is the old `postinstall` code, kept as a command
  for exactly this. It exits immediately once the binary is in place, so it costs
  a process on every run after the first.

  Only these two scripts need it. `electron-vite build` never looks for a binary,
  and electron-builder downloads its own copy for the platform it is packaging —
  which is why nothing about the release workflow changes.

### Changed

- **A stored password no longer enters the window.** It was the one documented
  exception to this app's rule that secrets stay in the main process, and it
  existed because the old client authenticated where it drew — CredSSP happened
  in the renderer, so the renderer had to be handed the password. The new client
  signs in in its own process, so the secret goes vault → main → pipe and the
  window is only ever told a session id. A password typed into the pane by hand
  still works, for hosts that have none saved.

- **The window may no longer compile WebAssembly.** `'wasm-unsafe-eval'` and
  `connect-src data:` were the price of the embedded client and left with it,
  along with `img-src blob:`. `src/renderer/csp.test.ts` now guards against
  their return rather than explaining why they are needed.

- **The renderer bundle loses about 6 MB.** The client used to ship inside it.

- `electron.vite.config.ts` states `build.externalizeDeps` where it used to list
  `externalizeDepsPlugin()`. electron-vite 5 deprecated the plugin in favour of
  the option; the behaviour is the same, and leaving native dependencies external
  is what keeps ssh2's crypto loadable in a packaged build.

- **`@electron-toolkit/tsconfig` 1 → 2**, which is the same base config with
  `moduleResolution` moved from `node` to `bundler`. Packages that describe their
  types through an `exports` map — `@vitejs/plugin-react` 5 among them — are
  invisible to the older setting, so `electron.vite.config.ts` stopped
  type-checking without it.

- **A packaged build no longer rebuilds native modules**, because it ships none.
  `npmRebuild: false`: ssh2's only compiled dependency is `cpu-features`, which
  it marks optional and loads in a try/catch — it picks a cipher by what the CPU
  can do, and without it ssh2 picks one itself, which is what every run in
  development already did. Left on, electron-builder handed the whole tree to
  node-gyp, which downloads Electron's headers to build a module nothing asked
  for: `npm run build:mac` then failed outright on a slow network, and could not
  run at all without one.

- **`mac.notarize` means the opposite of what it used to.** In electron-builder 26
  the Apple environment variables are what switch notarization on, and the option
  is only read to turn it off: `false` skips the step, and every other value
  leaves it to the environment. `electron-builder.yml` still says `false`, which
  is still the behaviour this repository wants with no certificate in use, but
  turning notarization on is now a matter of deleting that line rather than
  setting it to `true`.

### Removed

- **Clipboard and file transfer between the two sides.** Both rode on the old
  client's own extensions and neither survived the change. FreeRDP speaks the
  channel for both — `cliprdr` — so this is the next piece of work rather than a
  decision against them. Said plainly because it is a step backwards: text
  copied inside a desktop session does not paste out of it today.

- **Desktop panes on Linux, until its build is written.** The client is compiled
  per platform. A pane there says the client is missing rather than opening.
  Windows has a build script — `npm run build:freerdp:win`, using vcpkg where
  macOS uses Homebrew — but it has never been run, so treat it as written rather
  than working.

### Fixed

- **A frame was reassembled in a way that cost the square of its size.** The
  reader concatenated each piece arriving from the client onto one growing
  buffer — fine for a terminal, where a message is a line, and quadratic for a
  desktop, where a message is a frame: a full-screen 4K frame is 29 MB and
  arrives in something like four hundred pieces, so each one copied everything
  before it. Six gigabytes of memcpy per frame, which is what a scroll felt
  like. Held as a list, the same frame is copied once.
- **A pixel-for-pixel picture was given up to a rounding.** The canvas was sized
  by flooring the fitted scale to whole pixels, and a pane is measured in
  fractions of a point — so the fit landed a hair either side of one desktop
  pixel per device pixel, and every frame was resampled to be two device pixels
  narrower than the pane.
- **Scrolling ran fast one way and slow the other.** A backwards wheel turn is
  not the magnitude with a sign bit beside it: the low byte carries its two's
  complement, and the far end reads `-(0x100 - value)`. Three notches down were
  arriving as two hundred and fifty-three. The encoding moved to shared code
  where a test states what the far end will read back.
- **The pane toolbar took clicks meant for the desktop.** Full screen left a
  three-pixel strip of it over the picture, which both swallowed clicks and
  revealed the whole toolbar when the pointer passed — along the one edge where
  a remote desktop keeps its own tab strip, menu bar and window buttons. It now
  leaves entirely and cannot be hovered at all; pushing the pointer against the
  top of the display and holding it for half a second brings it back.
- **Desktop settings did not reach a session already open.** They were read once
  when the pane opened, so changing the size settings and saving them did
  nothing at all, with no sign of why.

### Notes

- None of the gateway path has met a real gateway yet. The pieces are tested —
  NTLM against the worked example in [MS-NLMP] 4.2.4, the tunnel handshake
  against a stand-in that answers each step and each refusal — but a first real
  attempt should be expected to fail on something small.
- The desktop client is compiled, which this project had avoided until now.
  `npm run build:freerdp:mac` builds it; `npm run build:mac` refuses to package
  without it. See [Building the desktop client](README.md#building-the-desktop-client).
- The loopback gateway, and the [MS-TSGU] implementation under it — `Gateway.ts`,
  `TsGateway.ts`, `ntlm.ts`, `md4.ts` and their tests — are no longer reached by
  the desktop path: FreeRDP speaks to an RD Gateway itself. They are left in
  place, tests and all, rather than deleted as a side effect of changing the
  client. Whether to retire them is a decision of its own; see
  `PLAN-freerdp.md`.

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
