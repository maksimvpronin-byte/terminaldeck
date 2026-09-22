# Plan: SFTP conflicts, path bar, and an on-connect command

> **Status: all four done.** Kept as the record of what was decided and why —
> particularly the refusals in section 1 and the security rule in section 4.


Four changes, written up before any code. Three touch the SFTP panel; the fourth
is independent and could land first.

Current state this builds on:

- `SFTPManager.upload` calls `fastPut`, which **overwrites without asking**. So do
  `uploadDirectory` and `uploadPath`, recursively.
- `SFTPManager.download` calls `fastGet`, which overwrites the **local** file just
  as silently.
- `SftpPanel` keeps `const [path, setPath] = useState('.')` — a relative start,
  never resolved, and shown nowhere. Navigation is double-click only.
- `SSHManager` opens the shell in `target.shell(...)` and hands the stream to the
  renderer. Port forwards start right after; nothing else is written to the shell.

---

## 1. Ask before overwriting on upload

### Why

Dragging a folder from Finder onto a production host currently replaces whatever
is already there, silently and recursively. This is the single most destructive
thing the app can do by accident, and it has no undo.

### Approach

Decide the whole batch **before transferring anything**, rather than prompting
mid-copy. A prompt that appears after 200 MB are already on the wire is worse
than useless: half the work is done and the user is answering under pressure.

**New main-side capability**

- `SFTPManager.statPath(connectionId, path): Promise<SftpEntry | null>` — a
  `stat` that answers "missing" instead of throwing.
- `SFTPManager.planUpload(connectionId, localPath, remoteParent): Promise<UploadPlan>`
  — walks the local tree exactly the way `uploadDirectory` will, and stats each
  intended destination. Returns:

  ```ts
  interface UploadConflict {
    localPath: string
    remotePath: string
    localSize: number
    localMtime: number
    remoteSize: number
    remoteMtime: number
    /** The destination exists but is the wrong kind — never overwritable. */
    kind: 'file' | 'directory-in-the-way'
  }
  interface UploadPlan {
    files: number          // total files the upload would write
    bytes: number
    conflicts: UploadConflict[]
  }
  ```

- `SFTPManager.upload` gains an `onConflict: 'overwrite' | 'skip'` decision map
  keyed by remote path, so the transfer itself needs no round trips.

**Renderer flow**

1. Drop or "Upload…" → `planUpload`.
2. No conflicts → transfer immediately, as today.
3. Conflicts → `UploadConflictDialog`, listing each with size and mtime on both
   sides, and per-row **Overwrite / Skip**, plus **Overwrite all**, **Skip all**,
   **Cancel**. Default selection is **Skip**, so a stray Enter cannot destroy
   anything.
4. The chosen map is passed to `uploadPath`.

### Edge cases that must be handled

- **A directory where a file is going** (or the reverse). Not a conflict to
  resolve — it is refused, listed separately in the dialog, and always skipped.
  `fastPut` onto a directory path fails anyway; the point is to say so up front.
- **Symlinks on the remote side.** A symlink destination is reported as a
  conflict with its own row, and overwriting follows the existing policy of not
  chasing links: it is refused rather than writing through to the target.
- **Permission denied on stat.** Treated as "unknown", shown as a conflict with
  a note, defaulting to Skip.
- **Case-insensitive local, case-sensitive remote.** Two local files can map to
  one remote name only when uploading a directory from a case-insensitive
  filesystem; the plan detects duplicate destinations and refuses the batch.
- Planning a very large tree costs one `stat` per file. Below a few thousand
  files this is unnoticeable; beyond that the dialog shows progress while
  planning, and planning is cancellable.

### Downloads

The same hole exists in reverse: `download` and `downloadDirectory` overwrite
local files without a word. The work is symmetrical and the dialog is reusable.
**Proposed: include it.** Flagged separately because it was not asked for — say
if you would rather leave downloads alone for now.

### Tests

`planUpload` splits into a pure part — given a local tree listing and a remote
listing, produce the conflict list — which is unit-tested: no conflicts, plain
overwrite, directory in the way, symlink, duplicate destinations.

---

## 2. Diff a conflicting file before deciding

### Why

"This file already exists" does not tell you whether it matters. The question is
always *what is different* — and today the only way to find out is to download
the remote copy by hand and compare it elsewhere.

### Approach

In the conflict dialog, each text-file row gets **Compare**. It opens a diff of
local vs remote for that one file. The same view is reachable from the remote
file context menu as **Compare with a local file…**, which is useful on its own.

**Diff engine** — `src/shared/diff.ts`, pure and dependency-free:

```ts
export type DiffLine =
  | { kind: 'same'; text: string; leftNo: number; rightNo: number }
  | { kind: 'added'; text: string; rightNo: number }
  | { kind: 'removed'; text: string; leftNo: number }
export function diffLines(left: string, right: string): DiffLine[]
```

Classic LCS over lines, with the usual head/tail trimming so a one-line change
in a large file stays fast. No dependency is added for this: the algorithm is
forty lines, and it is exactly the kind of pure logic this repo already tests.

**Guards, decided up front**

- **Binary files are not diffed.** Detection: a NUL byte in the first 8 KB. Such
  rows offer size and mtime only, and the Compare button is disabled with a
  reason.
- **Size cap: 2 MB per side.** Above it, the same treatment as binary. Reading a
  200 MB log into the renderer to diff it would hang the window.
- The remote side is fetched into the scratch directory and deleted when the
  dialog closes.
- Line endings: CRLF vs LF is reported as a one-line summary rather than marking
  every line changed — otherwise a Windows-edited file shows as entirely
  rewritten.

**View**

`DiffDialog`, inline (not side-by-side), monospace, `+`/`−` gutters coloured
from the existing palette variables. Unchanged runs longer than six lines
collapse to "… N unchanged lines", expandable. Rendering is capped at a few
thousand lines with a note, so a pathological diff cannot lock the UI.

### Tests

`diffLines`: identical input, pure insertion, pure deletion, a change in the
middle, empty either side, trailing-newline differences, and a file with no
common lines at all.

---

## 3. Editable path bar in the SFTP panel

### Why

The panel has no idea where it is. `path` starts as `'.'`, which is wherever SFTP
opened — usually the home directory, but not necessarily — and there is no way to
jump somewhere without clicking through the tree.

### Approach

- **Resolve on open.** New `SFTPManager.realpath(connectionId, path)` wrapping
  `sftp.realpath`, called once when the panel mounts so `'.'` becomes a real
  absolute path, and again after every navigation.
- **Path bar** across the top of the panel:
  - an editable input holding the current absolute path;
  - Enter navigates; Escape restores the current path and blurs;
  - a failed navigation leaves the text as typed and shows the reason inline
    rather than snapping back, so a typo can be fixed instead of retyped;
  - `~` and `..` are resolved through `realpath` rather than by string
    manipulation, so they behave as the remote shell would.
- **Typing the path of a file** navigates to its parent directory and selects the
  file. This is what people expect from pasting a path out of a log.
- **Breadcrumbs** under the input: each segment is clickable. The root and the
  current directory included.
- **Up** button for `..`, and Backspace as its shortcut while the list has focus.
- The existing auto-refresh and selection behaviour is untouched.

### Edge cases

- A path that exists but is not a directory → handled above (navigate to parent).
- No permission to read the target → error shown inline, current listing kept.
- Very deep paths: breadcrumbs scroll horizontally in their own container and
  never widen the panel.

### Tests

Path normalisation (joining, `..`, trailing slashes, root) is pulled into a pure
helper and tested; the rest is UI.

---

## 4. Run a shell command on connect

### Why

Every host has an opening move — `sudo -i`, `cd /var/log`, `tmux attach`,
`source /opt/env`. Typing it on every connect is exactly what the app should
absorb.

### Data model

Add to `AuthDefaults`, so it inherits along the chain the app already has —
host → group → parent group → inventory source — with blank meaning inherit:

```ts
/** Written to the shell once it is ready. Blank inherits; several lines run in order. */
onConnectCommand?: string
```

Placing it in `AuthDefaults` rather than on the session alone is deliberate: "every
box in this group starts with `sudo -i`" is the common case, and it should be
stated once.

### Where it runs

In `SSHManager`, inside the `target.shell(...)` callback, after the stream is
stored and the data listeners are attached — so whatever the command prints is
captured by the terminal and by session logging like any other output. It is
written as plain input, not a separate exec channel, which means:

- the user **sees** the command and its output, rather than it happening invisibly;
- it interacts correctly with the shell's own state — `cd` sticks, `sudo -i`
  hands over the session;
- a reconnect runs it again, which is the wanted behaviour.

Several lines are written in order, each terminated with `\n`.

### Security: this must never come from a repository

`onConnectCommand` is arbitrary code executed on every connection. It must be
readable **only from local configuration** — the session dialog, the group
dialog, the inventory source dialog and the local inventory override.

The Ansible parser maps a fixed list of `ansible_*` variables onto our fields;
**no variable will be mapped to this one**. Otherwise anyone able to commit to
an inventory repository would gain command execution on every host its readers
open, which is a supply-chain hole, not a feature. This is written down here so
that a later "let's read it from the inventory too" is a decision rather than an
oversight, and there will be a test asserting the parser never populates it.

### UI

- `SessionDialog` and `GroupDialog`: a small textarea under the connection
  settings, with the usual "inherited from *group*" placeholder.
- `InventoryOverrideDialog` and `InventorySourceDialog`: the same field, local
  only, with a line stating that it is never read from the repository.
- Quick connect: not offered — it is a throwaway connection with no profile.

### Edge cases

- **Timing.** The command is written as soon as the shell is ready, which can be
  before the prompt has printed. Harmless, and the echo looks the same as typing
  fast, but worth watching on slow hosts. If it turns out to race, the fallback
  is a short delay after the first byte of output rather than a fixed sleep.
- **A command that never returns** (`tmux attach`, `top`) is fine — it is just
  input.
- **Failing commands are not detected.** We are writing to a shell, not running
  an exec channel, so there is no exit status to check. This is a deliberate
  trade for visibility; the output is on screen.
- Interaction with port forwards: those already start before the shell write.

### Tests

Inheritance of `onConnectCommand` through the existing chain, and the parser
assertion that an inventory can never set it.

---

## Suggested order

1. **On-connect command** — independent of the SFTP work, small, immediately useful.
2. **Path bar** — independent, small, makes the panel usable for the rest.
3. **Overwrite confirmation** — the safety fix; the largest of the four.
4. **Diff** — builds on the conflict dialog from step 3.

Steps 1 and 2 can land and be used while 3 and 4 are still in progress.

## Decisions taken

- **Downloads are included.** The overwrite confirmation covers both directions;
  a download that would replace a local file asks the same way an upload does.
- **Nothing is remembered.** No "always overwrite on this host", no per-session
  memory, no preference to switch it off. Every batch asks. An answer given once
  under time pressure should not silently govern every later transfer, and the
  cost of asking is a click against the cost of a file that cannot be recovered.
