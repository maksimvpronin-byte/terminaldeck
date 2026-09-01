# Changelog

The version in `package.json` is the one the app reports and the one
`electron-updater` compares against. A `v*` tag matching it is what actually
publishes a release — see [Releasing](README.md#releasing). Bumping one without
the other produces a version nobody can install, which is how 0.1.10 through
0.3.2 came to be written and never released: no tag, so no build ever ran.

## 0.5.1

### Added

- **The idle lock delay is a setting**, in Settings → Security: never, or from a
  minute to a working day, fifteen as before. The right answer is a property of the
  room rather than of the application — fifteen minutes is impatient for someone
  reading a build log on a machine nobody else can reach, and generous for a
  laptop on a desk in an open office.

### Fixed

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
