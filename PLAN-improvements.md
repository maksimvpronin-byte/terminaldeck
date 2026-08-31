# Plan: checks first, then the hot path, then the duplication

> **Status: sections 1 to 5 and 7 are done. Section 6 has taken three files and
> has the JSX of two of them left.**
>
> Section 4 was taken out of order and deliberately: it is small, it touches the
> vault, and the tests from section 2 had just been written. Sections 6 and 7
> were taken a file at a time, each split before it was translated so the same
> lines were not edited twice.
>
> Each section carries a note of what actually landed and what it found on the
> way, since several of them found more than they set out to.

Written after an audit of the whole tree at v0.4.0: 26.5k lines, 150 files, 29
test files. The code itself is in good shape — no `any` outside prose comments,
`main`/`preload`/`shared`/`renderer` stay separated, and the pure logic in
`src/shared` is tested. So none of this is a rewrite. It is the list of gaps that
an audit finds and daily work does not.

The ordering is deliberate: the checks come first because every later item on
this list is a refactor, and a refactor without checks is a bet.

---

## 0. What the audit found

Facts, so later sections do not have to restate them:

- `.github/workflows/release.yml` triggers on `v*` tags only. It runs
  `npm run typecheck`; it does **not** run `npm test`.
- No other workflow exists. So nothing is checked on push, and the 29 test files
  run only when someone types `npm test` by hand.
- There is no ESLint and no Prettier — neither a config nor a dependency — yet
  fourteen `eslint-disable-next-line` comments are scattered through the source:
  eleven for `react-hooks/exhaustive-deps` in the renderer, three for
  `no-console` around the gated `trace()` helpers in `src/main/rdp`. Not one of
  the rules they silence has ever run.
- `@electron-toolkit/tsconfig` sets `strict: true` but `noImplicitAny: false`.
- `vitest.config.ts` includes `src/**/*.test.ts` under `environment: 'node'`, so
  a `.tsx` test cannot exist and no component is covered.
- `SSHManager` sends every shell chunk as its own base64 IPC message; the
  renderer decodes it with a per-byte `charCodeAt` loop. There is no batching and
  no backpressure.
- The terminal runs on xterm's DOM renderer, from the deprecated `xterm` /
  `xterm-addon-*` packages.
- `crypto.deriveKey` uses `scryptSync` at N=2^15, on the main process.
- The credential form is written three times: `SessionDialog`, `GroupDialog`,
  `InventoryOverrideDialog`.
- `useT` exists and works, but only 9 of ~35 renderer files call it.

---

## 1. Checks that run without being asked

### Why

Three separate problems share one cause.

The tests do not run. Not rarely — never, unless remembered. A test that is
written and not executed is a file, not a safety net. This matters more here than
in most projects because a large share of the code cannot be exercised on the
machine it is written on: `WinSessions.ts`, `ntlm.ts`, `md4.ts`, `TsGateway.ts`,
`ShadowHostBridge.ts` and the named-pipe branch of `agentSockForPlatform()` are
Windows-only paths developed on macOS. Their tests are the only thing that can
say whether they still work.

Breakage surfaces at the worst moment. The first compile check today happens
after `git push --follow-tags`, when three runners have already started. The
`Check the tag matches package.json` step in `release.yml` exists precisely
because that lesson was learned once already; this is the same lesson one step
earlier.

And a broken commit sits in `main` unnoticed. With a single branch and a linear
history, there is no review step to catch it either.

### Approach

**`.github/workflows/ci.yml`** — one job on `ubuntu-latest`, triggered on push to
any branch and on pull requests into `main`:

```
npm ci → npm run typecheck → npm test
```

Ubuntu alone, to start. The tests are pure Node modules with no platform
branches, and one runner keeps a push under two minutes. A three-OS matrix is a
reasonable follow-up once the job is reliably green — but it should be added
because a platform difference actually bit, not pre-emptively.

`concurrency` with `cancel-in-progress`, so a quick series of pushes does not
queue up runs nobody will read.

`npm ci` is cheap here: Electron 42 dropped its `postinstall`, so no 100 MB
binary is downloaded — that only happens under `npm run dev`, via
`install-electron`.

**`npm test` added to `release.yml`**, after the typecheck. A release currently
builds and publishes even with failing tests.

**ESLint + Prettier**, as a second commit. `eslint`, `@eslint/js`,
`typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-config-prettier`,
`prettier`, a flat `eslint.config.mjs` (`.mjs` because the package is CommonJS),
and `lint` / `format` scripts. The fourteen existing disable comments are the
specification: they name the rules the code already assumes are enforced, so the
rule set stays small and every rule in it is one the source has already asked
for. Each of those sites then gets read once — some are correct suppressions,
some are probably stale bugs.

`exhaustive-deps` starts as a warning rather than an error. Nobody has ever seen
its output on this tree, so the eleven marked sites are a lower bound on what it
will find, not a count. It gets promoted after the first run is triaged.

Prettier's settings are the ones the source was already written to
(`singleQuote`, no semicolons, width 100, no trailing commas — the electron-vite
scaffold defaults), and `.md` is left out of its reach: reformatting every plan
document is not a change anyone wants to read.

Deliberately a separate commit, and the `lint` and `format:check` steps only join
`ci.yml` once the dependencies are installed and the first run has been read. A
CI job that is red on arrival teaches everyone to ignore CI.

**`noImplicitAny: true`** in both `tsconfig.node.json` and `tsconfig.web.json`,
overriding the toolkit base. With zero explicit `any` in the source the cost is
likely a handful of untyped callback parameters.

**`include: ['src/**/*.test.{ts,tsx}']`** in `vitest.config.ts`. On its own this
only removes the obstacle; the component tests that make it worth anything belong
to section 2.

### Done when

A push shows a green tick, and a deliberately broken line shows a red one.

### What the first run found

Kept as the argument for the whole section: eight findings on 26.5k lines, on a
tree nobody had ever linted.

- **A real bug.** `GraphicalHost`'s resize effect reads `look.desktopWidth` and
  `look.desktopHeight` in `desiredSize()` but did not list them, so editing the
  resolution of a *pinned* desktop left the observer asking the far end for the
  size the session was opened with, until something else on the list changed.
  This is exactly the class of fault the rule exists for, and it was found by
  the run that turned the rule on.
- **Three errors, all safely removable.** A ternary used as a statement in
  `Gateway.test.ts`; a `try/catch` in `TsGateway.ts` whose `catch` only rethrew,
  where the explanation it carried was worth keeping and the wrapper was not; and
  a `\$` in `OSC7_SHELL_SETUP` that JavaScript never needed — the emitted shell
  line is byte-for-byte what it was.
- **Three suppressions that suppressed nothing** — one in `GraphicalHost`, two in
  `ShadowView` — deleted. Written blind, against a rule that had never run, and
  each one had been quietly claiming a problem existed where there was none.
- **One warning that is right to suppress**, in `TerminalHost`: the cleanup
  increments a generation counter, which is the point of it. The rule is aimed at
  refs holding DOM nodes. It now says so in a comment instead of going unanswered.

### Reading the rest, and turning the rule up

The eight suppressions that survived the first run were each read afterwards.
All eight turned out to be right, and every one of them is the same shape: a
function declared in the component body, left out of the list because listing it
would re-run the effect on every render — tearing down a live shadow session, or
restarting a five-second poll so often it never fires, or disposing a terminal to
change a colour. Each now carries a sentence saying so, because a bare
suppression is what let the three dead ones sit unnoticed.

With that read, `exhaustive-deps` is an **error**. And
`reportUnusedDisableDirectives` is an error too: a suppression that has stopped
suppressing anything claims a problem where there is none, and three of those had
accumulated before the linter first ran.

Eight `exhaustive-deps` suppressions from before the linter still stand, in
`SftpTree`, `SftpPanel` (three), `ImportSshConfigDialog`, `ShadowView`,
`useAppearance` and `TerminalHost`. ESLint confirms each is silencing something
real; whether each *should* is a separate reading, and it is what stands between
the rule and being promoted to an error.

---

## 2. Tests where a silent failure costs most

### Why

The existing tests were chosen well — the parsers, the inheritance chains, the
planners, everything that fails by producing a plausible wrong answer. But three
modules that can *lose user data* have no tests at all.

`Vault.changePassword` re-encrypts every stored secret under a new key. If it
drops one, the password is gone, and it is gone quietly — nothing throws, the
entry simply stops working the next time that host is opened, possibly weeks
later.

`Backup.exportToFile` / `importFromFile` re-encrypt secrets under a separate
password and merge a foreign tree back into the local one. This is the migration
path between machines, so the first time it is used in anger is also the moment
the old machine is being wiped.

`SFTPManager` is where `TransferPlan` decisions turn into `fastPut` and
`fastGet`. The planner is tested; its execution is not — and that is the half
that overwrites files.

### Approach

Round-trip tests, on a temp directory, with the Electron `app.getPath` seam
faked:

- Vault: create → store several secrets → change password → every secret still
  decrypts; wrong password rejected; the temp-file-and-rename write survives a
  simulated crash between the two.
- Backup: export with and without secrets → import into an empty store → the
  tree matches; import with the wrong password fails without touching the
  existing store; a truncated file is refused rather than half-applied.
- SFTP: the overwrite/skip decisions from `TransferPlan` produce the writes they
  claim to, against a stub sftp session put straight into the manager's session
  map — so nothing reaches SSHManager or a host.

Then, once vitest can see `.tsx`, one component test per inheritance dialog —
because section 5 is about to move that code.

### What landed

Three files, 34 tests, no host and no Electron involved:

- `src/main/vault/Vault.test.ts` — the rotation carries 22 secrets across,
  including non-ASCII and a 5 KB one; the salt, the verifier and every
  ciphertext change, so it is a genuine re-key rather than a rewritten verifier;
  the old password stops working and a wrong *current* password leaves the file
  byte-for-byte as it was. Plus: locked reads refuse, a failed unlock leaves the
  vault shut, and a `.tmp` left by an interrupted write is ignored.
- `src/main/store/Backup.test.ts` — the migration path end to end: export with
  credentials, wipe the stores, create a vault under a *different* master
  password, import, and find every host, group, snippet, collection, inventory
  source and override back with its secret readable under the new master. Plus
  the refusals: no password for an export that has credentials, the wrong
  password, a file that is not an export, a truncated file — each of which must
  leave the stores untouched, which is what the "secrets first" ordering in
  `importFromFile` buys and what the test now pins down. And the documented
  promise that an export carries only the secrets something in it points at,
  never the vault's orphans.
- `src/main/ssh/SFTPManager.test.ts` — `runPlan` against a stub session: a file
  marked `skip` is not written, missing remote parents are created deepest-last
  and only when absent, a download makes its local directory on the way, and a
  relay makes the directory on the *receiving* host. The last one pins the
  safety property the code documents: when the source cannot be opened, the
  destination is never opened either, so a permission error leaves no empty file
  behind on the far host.

---

## 3. The terminal hot path

### Why

Four things stack up on noisy output — `cat` on a large file, `tail -f` during a
deploy, a build log:

1. **base64 both ways.** `SSHManager.ts:286` sends `data.toString('base64')`;
   `TerminalHost.tsx:28` decodes it with
   `Uint8Array.from(atob(b64), c => c.charCodeAt(0))` — a per-byte JavaScript
   loop, on top of 33% more bytes across the boundary.
2. **One IPC message per ssh2 `data` event.** No coalescing at all.
3. **No backpressure.** The main process sends regardless of whether xterm is
   keeping up, so a flood grows the renderer's queue instead of slowing the
   remote down.
4. **The DOM renderer.** Neither the webgl nor the canvas addon is installed —
   the slowest path xterm offers.

### Approach

Structured clone carries a `Uint8Array` over IPC natively and `term.write()`
accepts one, so the base64 hop can go entirely.

Coalesce chunks in `SSHManager` on a short timer (~8 ms) with a size threshold to
flush early, so a burst becomes a few large writes instead of hundreds of small
ones — while a single keystroke echo still arrives on the next tick.

Backpressure through the callback form: `term.write(data, cb)` fires when the
data is parsed, so the renderer can acknowledge and the main process can
`stream.pause()` / `stream.resume()` around the outstanding window. This is the
part that turns a memory problem into a flow-control problem.

Migrate `xterm` → `@xterm/xterm` and the two addons to `@xterm/addon-*` (the
current names; the installed ones are deprecated), then add
`@xterm/addon-webgl` for machines that can use it.

Sequenced this way each step is separately revertable, and the migration is the
only one that touches package versions.

### What landed

All four steps, the migration as its own commit — it is the only one that needs
an install, and entangling a package rename with a change to the wire format
would have left neither separately revertable.

Output now collects in a per-connection outbox and is handed over as one message
every 8 ms, or sooner once 64 KB have piled up. The bytes travel as a `Buffer`
and arrive as a `Uint8Array` that goes straight into `term.write` — the base64
hop is gone from both ends, and with it the per-byte `charCodeAt` loop.

Backpressure is a round trip: the renderer acknowledges each chunk from
`term.write`'s callback, which fires once xterm has parsed it. Past a megabyte
outstanding the connection is paused — stdout and stderr both, since a build
pours warnings out of the second one — and it resumes once the backlog is under
256 KB. Pausing an ssh2 stream propagates through SSH's own window, so the far
end stops sending rather than this end stopping reading.

One thing coalescing quietly threatens: output still held when a connection
closes. The last thing a host says is usually the reason it went, so the close
handler flushes before it sends the status, rather than letting a connection
that ended inside a flush interval take its own epitaph with it.

`src/main/ssh/SSHManager.test.ts` covers the batching and the backpressure
against a stub connection — including that an over-reported acknowledgement
cannot drive the backlog negative and quietly disable pausing for good. The
connect path is still untested; it needs a host.

Then the packages: `@xterm/xterm` 5.5 and `@xterm/addon-{fit,search}` under
their current names, plus `@xterm/addon-webgl`, loaded after `term.open` and
wrapped in a `try` — a machine with no working WebGL keeps the DOM renderer,
which is what shipped before. Lost contexts dispose the addon rather than
leaving a dead canvas, since disposing puts that same DOM renderer back.

**A deviation from the approach above:** it said "with a canvas fallback", and
the fallback is the DOM renderer instead. `@xterm/addon-canvas` would be a
fourth package on a path that only runs where WebGL is unavailable — and the
DOM renderer is the one this app has always used, so the rare case degrades to
the known-good state rather than to a third path nobody has ever exercised.

---

## 4. The vault's two small edges

### Why

`scryptSync` at N=2^15 blocks for a few hundred milliseconds — on the main
process. Unlocking the vault, rotating the master password and importing a backup
therefore freeze every live terminal in the app, including ones mid-transfer.

`Vault.lock()` sets `this.key = null` but does not clear the buffer first, so the
derived key stays in freed heap memory after a lock that exists to remove it.

### Approach

The async `scrypt` with a promise wrapper — same parameters, same file format,
no migration. `this.key.fill(0)` before nulling, plus the same for the transient
keys in `Backup`.

Small, self-contained, and worth doing right after section 2 covers the vault.

### What landed

`deriveKey` now returns a promise and runs on Node's thread pool. Same
parameters, same output, same vault file — nothing to migrate. Three methods
follow it into being asynchronous — `Vault.create`, `unlock` and
`changePassword` — and with them the three IPC handlers. Everything that reads a
secret stays synchronous, because it uses the key that is already held: nothing
on the connection path had to change.

`wipe()` overwrites a key where it lies, and is called wherever one stops being
needed: `lock()`, a key replaced by a new one (through a small `adopt` that owns
that rule), the wrong key from a failed unlock, the check key in
`changePassword`, and both transient keys in `Backup`. Plaintext secrets pass
through JavaScript strings and cannot be wiped; this claims nothing about those.

Two things the rewrite surfaced, neither of them the point of it:

- Making `changePassword` asynchronous opened a window for the idle timer to
  lock the vault mid-rotation, which would have left the method comparing
  against a key that had just been zeroed — and reporting a wrong password for
  what was really a closed vault. It now checks, and says which one happened.
- In `Backup.importFromFile` the derivation sat inside the `try` whose `catch`
  reports a wrong password. It has been moved out: deriving cannot fail for a
  wrong password, and reporting an out-of-memory that way would send someone
  hunting for a password that was right all along.

The test that keeps it honest is `derives off the main thread, so everything
else keeps running`: it starts an unlock, schedules a `setImmediate`, and
requires the timer to have fired by the time the unlock resolves. Under
`scryptSync` nothing else can run at all, so putting it back fails that test
rather than quietly restoring the freeze.

---

## 5. One credential form instead of three

### Why

`SessionDialog` (537 lines), `GroupDialog` (321) and `InventoryOverrideDialog`
(356) each carry a near-identical copy of the same logic: `chooseInheritance`,
the `pending` object, the `inheritNote`/`from` helper, `ownSecret`, the auth
method select with its `Inherit (…)` option, the key-path row, and the note about
forgetting a credential of one's own.

The count was first written here as "roughly 400 duplicated lines", which was
wrong and worth correcting: the three dialogs shed 94 lines between them, and the
two new files add 273, most of it documentation. **The line arithmetic does not
favour this refactor and never did.**

The reason to do it is the other sentence: the inheritance rules are the subtlest
thing in the app, and they were maintained in triplicate, so a fix applied to two
of the three was a bug that only appeared on whichever screen was missed. That is
not a hypothetical — see what the extraction found, below.

### Approach

An `<AuthFields>` component, following `AppearanceFields` and `RdpFields`, which
already solve exactly this shape and are the reason the pattern is obvious.

Deliberately after section 2: the tests for the three dialogs are what make this
move safe, and they should be written against the current behaviour, before it
moves.

### Step one: the rules, before the markup

**A deviation from the approach above**, which called for a component test per
dialog. Those need jsdom, a testing library and the queries to match markup
exactly — a lot of apparatus, and apparatus that pins the markup rather than the
behaviour it is meant to protect.

The subtle part of these three dialogs is not their markup. It is the
inheritance arithmetic: what a blank field resolves to, what a pending "forget"
would fall back to, whether a key file and its passphrase come from the same
place, and what to hand the store when the user saves. That part is pure, and it
moves out into `src/shared/authFields.ts` — beside `authResolution.ts` and
`appearance.ts`, which are renderer-facing pure modules for the same reason —
with `src/shared/authFields.test.ts` covering it in the environment that already
exists. No new dependency, and the net is under the part that could break
quietly. The markup that follows is mechanical, and wrong markup is visible on
sight in a way that a wrong fallback is not.

`secretToSave` goes with it: "something typed now beats the forget tick" was
written out in all three dialogs, and "agent authentication stores nothing" in
only one of the three — a group set to agent authentication would have saved a
password left in the box.

**And a bug, which is why the extraction was worth doing at all.**
`InventoryOverrideDialog` layered the override two different ways three lines
apart: `applyOverride` for the appearance, a plain spread for the connection
settings. A plain spread writes a cleared field's `undefined` over the value
underneath instead of falling back to it — so a field set back to "from the
inventory" showed the *group's* setting, while the connection, which the main
process layers with `applyOverride`, used the repository's. The dialog stated
one thing and the app did another, which is precisely what the comment on
`applyOverride` warns against. Both now go through one merge, and the rule has a
test.

### Step two: the component

`src/renderer/src/components/AuthFields.tsx`, alongside `AppearanceFields` and
`RdpFields`, holding the controls: the method select, the password box, the key
file row with its passphrase, the split-credential warning and the note about a
credential of one's own. The prose that genuinely differs between a host, a
group and an inventory host arrives as a small `AuthWords` object; the controls
do not differ, and now there is one of them.

Each dialog keeps a `setAuth` of its own, the way it already keeps `setLook` and
`setRdp` for the other two field groups.

**What the three copies had quietly drifted into** — every one of these is a
behaviour change, and none of them was the point of the refactor:

- An inventory override had **no passphrase box at all**. A repository host
  using a key with a passphrase could not be given one locally, though the vault
  and the resolver both supported it.
- Only `SessionDialog` warned when a key file and its passphrase resolved from
  **different places**. The same trap existed for groups and overrides, unsaid.
- `GroupDialog` would **save a password left in the box under agent
  authentication**; the other two would not.
- Two of the three offered "Inherit (*the method it is using now*)" rather than
  the method inheriting would actually give — the option described the state it
  was leaving. The override dialog had this right, which is how it was noticed.
- The override dialog's preview ignored a pending "forget"; the other two
  reflected it. It reflects it now.
- Its note about a locally held credential now sits after the key row rather
  than between the password and the key file, so all three read in one order.

`GroupDialog` and `InventoryOverrideDialog` also pick up the Russian labels the
component carries, which they never had — a few lines of section 7 arriving
early because the strings moved anyway.

---

## 6. Three files that outgrew themselves

`GraphicalHost.tsx` (1104), `SftpPanel.tsx` (1027) and `ipc/handlers.ts` (694
lines, 75 handlers).

The renderer components split along the seams they already have internally.
`handlers.ts` splits by domain into `ipc/ssh.ts`, `ipc/sftp.ts`, `ipc/store.ts`,
`ipc/inventory.ts`, `ipc/rdp.ts` and so on, each exporting a `register…`
function — the same shape `state/slices/` already uses on the renderer side.

Lowest priority of anything here: it is real, but it is a readability cost, not a
correctness or performance one, and it makes a large diff that hides the
interesting ones. Best done last, or opportunistically when a section already has
one of those files open.

### What landed: the SFTP panel's first two seams

Taken before section 7's second pass on purpose — translating a file and then
splitting it means editing the same lines twice.

**`src/shared/fileSize.ts`.** `formatSize` was written out twice, identically, in
`SftpPanel` and `TransferConflictDialog` — the two places in the app that put a
size in front of someone, and so the two that would have had to be found and
changed together. One copy now, with a test that pins the things a rewrite would
get wrong: powers of 1024 rather than 1000, one decimal place so 1.5 GB is not
2 GB, and counting on past TB rather than running off the end of the unit list.

**`src/renderer/src/state/sftpLayout.ts`.** Every width in the panel, and what of
it survives a restart. The panel knew four localStorage keys and wrote to them
from five places; it now knows none. The reading and writing sit behind
`load…`/`save…` functions and everything above them is pure, which is what makes
`sftpLayout.test.ts` possible: a stored width that is rubbish, negative or from a
much larger screen, a column layout saved before the name column could be dragged
at all, and the arithmetic that keeps the header over its rows.

`SftpPanel` is 1038 lines down to 933.

### What landed: the IPC handlers

`ipc/handlers.ts` was 697 lines and 75 registrations in one function. It is now
29 lines that call seven `register…` functions, one per domain — the shape
`state/slices/` already uses on the other side of the boundary. The largest of
the seven is `rdp.ts` at 200 lines.

The seams were already marked: the file carried `// --- Vault ---`,
`// --- SFTP ---` and so on, and the split follows them exactly. The helpers
partitioned too — `focusedWin` is wanted nearly everywhere and became `win.ts`;
the three credential helpers are wanted by the store and by inventory overrides
and became `secrets.ts`; the rest each had one domain and went with it.

The handler bodies were moved by script rather than retyped, and what makes that
safe to claim is a comparison rather than a reading: the sorted list of channels
registered across the new files is identical to the list the old file
registered, all 61 of them. A refactor of this shape fails by losing one
quietly, and typechecking would not have said a word about it.

Two things the script got wrong on the first pass, both worth writing down. It
resolved imports by looking for each name in the file's text, so it imported
`dialog`, `app` and `vault` into modules that only *mentioned* them in prose —
"saving a dialog nobody typed a password into" is not a use of `dialog`.
Comments are stripped before the scan now. And an unpacked loop variable leaked
into a comprehension, marking every value import as a type import; that one
would have failed the build immediately, which is the difference between the two
mistakes.

### What landed: the desktop's size

`GraphicalHost`'s `desiredSize` was eighty lines of arithmetic and sixty of
explanation, inside a component, reachable only through a live RDP session on a
particular display. It is now `src/shared/desktopSize.ts`, which takes the pane
in CSS points, the display's density and the host's settings, and answers with
the size to ask for. The component keeps the two facts the calculation cannot
know — how large the pane is at this moment, and what display it is on.

The tests earned themselves immediately: three of the expectations written for
them were wrong, and in the same direction. A full-screen pane on a Retina
display asking for every pixel wants five million of them, and the default
budget is three and a half — so the cap bites in the ordinary case, not the
extreme one, and the factor that comes out is 1.67 rather than the 2 the
magnification asked for. That is worth knowing about a setting people will
change, and nothing in the app says it. It has a test of its own now, named for
the surprise.

`GraphicalHost` is 1104 lines down to 1055 — a small dent, because most of what
moved was the explanation, and the explanation moved with the code it explains
rather than being left behind to rot beside a call.

### What landed: dragging between two panels

`src/renderer/src/state/sftpDrag.ts` — the drag type, the payload, the
module-level record of what is being dragged right now, and the rule for whether
a panel takes it. Three lines inside a thousand-line component before this,
reachable only by dragging a file between two live SSH sessions, and now with a
test: files from the desktop always; rows from another host's panel yes; rows
from this same panel no, because the destination is the directory they are
already in and every one of them would clash with itself.

Moving it turned up a smaller thing worth having. `targets.map((t) => t.path)`
shadowed `t` — which, since section 7, is the translator in that component and in
most others. Nine callbacks were doing it. They all worked, because the shadowed
`t` was only ever a tab or a tag, but the next person to translate a string
inside one of them would have found `t` meaning something else. All nine
renamed; the same pattern in `state/` is left alone, since nothing there has a
translator to shadow.

### Where the split stopped, and why

What is left in both `SftpPanel` and `GraphicalHost` is JSX — the header, the
rows, the toolbar — and lifting those into components is a props-passing exercise
with nothing testable at the end of it: readability, bought with a large diff
whose mistakes only show on screen. The seams taken here are the ones where the
code was *pure and untested*, which is where a silent mistake could already have
been hiding. The JSX split is still worth doing; it is worth doing where someone
can look at the result.

---

## 7. Half a Russian interface

`useT` and `ru.ts` work, but only 9 of ~35 renderer files use them. `SessionDialog`
has 74 `t()` calls; `GroupDialog` has 16 for a comparable amount of text, and
`CollectionDialog`, `InventorySourceDialog`, `BackupSettings` and
`SecuritySettings` have none. The result is a screen that is Russian in one
dialog and English in the next one it opens.

The fallback behaviour is right — a missing key renders the English source, so
this degrades visibly rather than into machine names. The work is a pass over the
untranslated files plus the matching entries in `ru.ts`.

Worth doing after section 5, since extracting `<AuthFields>` removes two thirds
of the strings that would otherwise need translating three times.

### What landed, and what has not

**A first pass**, over the screens on the way in and the two settings tabs:
quick connect, the credential prompt, security settings, export and import, and
the update banner. 46 phrases, and the three dialogs from section 5 came with
their own.

**Placeholders**, which the phrase book did not have. `translate` now fills
`{name}` after the lookup, because the alternative is assembling a sentence from
translated fragments and fragments only reassemble in the language they were
split in: "Version 1.2 is available" and "Доступна версия 1.2" do not put the
number in the same place. `src/renderer/src/i18n/language.test.ts` covers it.

**A test that keeps the book honest** — `i18n/coverage.test.ts`. It reads every
renderer source, collects the phrases passed to `t()`, and fails on one the book
does not have. A missing entry falls back to English, so nothing breaks and
nothing says anything either; this is what says it. It also checks that a
translation carries the same placeholders as its key, since a translation that
drops `{version}` prints a sentence with a hole in it.

**`ErrorBoundary` stays in English on purpose.** The phrase book is read through
the store, and that screen exists for the case where something in that tree has
just thrown; asking the crashed application to look up its own error message is
how a crash screen becomes a blank one.

### The second pass: the file browser

Taken after section 6 had been through the same file, so the lines were edited
once rather than twice.

27 more phrases: the context menu, the toolbar buttons and every one of their
tooltips, the column headers and their drag handles, the delete confirmation,
and the transfer notice. Several needed the placeholders from the first pass —
"Delete {count} items", "Mode {mode}", "Drag to resize {column}" — which is what
that pass was for.

`SftpTree` turned out to need nothing at all: every word in it is a path or a
folder name that came from the host.

### The third pass: inventory and collections

74 phrases across four files — the inventory tree and its source dialog, the
collections panel and its dialog. The phrase book is now 472 entries.

**Counted things had to be reworded, in English as well as Russian.** The book
matches whole strings, and `${n} host${n === 1 ? '' : 's'}` is not a string —
it is two, and Russian needs three (1 хост, 2 хоста, 5 хостов). Every counted
line was turned around to put the number last: "Hosts: 3", "hosts: 3, groups: 1",
"read 4 files". One entry then serves every number in both languages. The English
reads a little more like a label and a little less like a sentence, which is the
price.

`ago()` in the inventory tree sits outside the component and cannot call a hook,
so it takes the phrase book as its first argument. Worth noting as the pattern
for the next such helper.

Three of the keys added were **already in the book** — `Connect`, `Connected`,
`Connect in split`, from the session tree. Duplicate keys in an object literal
are legal JavaScript and the last one wins, so the app would have been fine and
the older translation would have quietly stopped being used. `no-dupe-keys` is in
`eslint:recommended` and would have failed the build, which is the argument for
section 1 in one line.

### The last pass: everything else

Tunnels, monitoring, both palettes, the diff and transfer-conflict dialogs, the
`~/.ssh/config` importer, the appearance fields, the shadow view and the
terminal's own context menu and search bar. The book is 554 phrases and nothing
asks for one it has not got.

**Two things are deliberately left in English**, and both for the same kind of
reason. `ErrorBoundary`, because the phrase book is read through the store and
that screen exists for when something in that tree has just thrown. And the
status lines the app writes into the terminal itself — `Connecting...`,
`[connection closed]` — because they are written from callbacks whose dependency
lists are deliberately empty, and dragging the phrase book into those closures to
translate four words is a worse trade than leaving them.

**A lookup table is not a phrase.** `REFUSAL[c.reason]` and `BLOCKED[…]` were
tables of English strings, passed to `t()` by key at runtime — which the coverage
test cannot see, because it reads the source for `t('…')`. So both became small
functions of literal phrases. The invariant the test rests on is that every key
is written out; a table quietly breaks it, and the test would have said nothing.

**And the test was reading its own documentation.** It picked up `t('…')` out of
a comment explaining how it works, and duly demanded a translation for `…`.
Comments are stripped before the scan now — the second time in this plan that a
tool was fooled by prose about the code it was scanning, after the IPC split
script imported `dialog` into a file that only mentioned one.

---

## Order, in one line

1 (checks) → 2 (tests for what loses data) → 4 (vault edges) → 3 (hot path) →
5 (`AuthFields`) → 7 (i18n) → 6 (splitting files).

Sections 1 and 2 are what make the rest cheap. Section 3 is the one users would
notice. Sections 5–7 are the ones that keep the codebase pleasant to work in, and
none of them should jump the queue.
