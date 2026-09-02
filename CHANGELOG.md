# Changelog

The version in `package.json` is the one the app reports and the one
`electron-updater` compares against. A `v*` tag matching it is what actually
publishes a release — see [Releasing](README.md#releasing). Bumping one without
the other produces a version nobody can install, which is how 0.1.10 through
0.3.2 came to be written and never released: no tag, so no build ever ran.

## Unreleased

### Fixed

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
