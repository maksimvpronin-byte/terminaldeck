# Plan: removing shadow sessions

> **Status: done, on 2026-09-10, in the order below.** Mapped from the tree at
> v0.13.2 and carried out the same day. Kept as the record of what was taken out
> and why, since none of it is readable from the tree that is left.
>
> **One thing the map got wrong.** Section 2 said `qualifyUser` had to be rescued
> because an ordinary RDP login used it. It did not: its only caller was
> `shadowCredentials`, which went with the feature, and the normal login path
> resolves a domain through `splitLogin` in `shared/rdpLogin.ts`. So
> `shared/winSessions.ts` went whole and no new module was needed.
>
> **And one it missed.** Section 8 said the help never mentioned the feature.
> The help calls it *joined* and *watched* rather than *shadow*, which is why a
> search for the word found nothing: two rows in "Remote desktops" went too, and
> `i18n/coverage.test.ts` would have caught them the moment their translations
> were left behind.
>
> Written in English to match the other `PLAN-*.md` files.

The decision is to take out the whole feature — joining a session that is
already open on a Windows host — and not only the `mstsc` window that drew it.
The session listing exists to fill that picker and has no other reader, so it
goes with it. The experiments the feature grew out of go too.

---

## 1. What is being removed

Four layers, and each one holds the next up.

**The pane.** [`GraphicalHost.tsx`](src/renderer/src/components/GraphicalHost.tsx)
carries the picker: the `sessions` / `sessionsLoading` / `sessionsProblem` state
(lines 102–104), the `joined` state and the branch that hands the pane over to a
joined session (113, 216–230), the query effect (165–200), and the block of JSX
from "Or join a session already open" to the "not asking the person there"
checkbox (288–345). [`ShadowView.tsx`](src/renderer/src/components/ShadowView.tsx)
goes whole, 168 lines. The `.session-pick-*` rules start at
[`styles.css:1307`](src/renderer/src/styles.css:1307).

**The bridge.** `shadowStart`, `shadowPlace`, `shadowVisible`, `shadowStop`,
`onShadowEvent` and `rdp.shadow` in
[`preload/index.ts`](src/preload/index.ts:263); their channels and
`rdp:listSessions` in [`ipc-channels.ts:148`](src/shared/ipc-channels.ts:148);
the handlers at [`ipc/rdp.ts:252`](src/main/ipc/rdp.ts:252) together with the
`shadowCredentials` helper above them (line 31);
[`ShadowHostBridge.ts`](src/main/rdp/ShadowHostBridge.ts) whole, 198 lines; and
the `stopAll()` on the way out at
[`main/index.ts:267`](src/main/index.ts:267) with its import on line 10.

**The Windows side.** [`WinSessions.ts`](src/main/rdp/WinSessions.ts), 438 lines
of remoting and `mstsc /shadow`, and most of
[`shared/winSessions.ts`](src/shared/winSessions.ts) — see section 2 for the one
function that has to survive it. `resources/shadowhost/` (ShadowHost.cs and its
build script) and `resources/shadowprobe/` both go; so does
`resources/remoteassistance-native/`, the Rust experiment from the same
investigation.

**The build and the release contract.** `build:shadowhost` at
[`package.json:25`](package.json:25) and its call inside `build:win` (line 32);
the `extraResources` entry at
[`electron-builder.yml:68`](electron-builder.yml:68); in
[`verify-release.cjs`](scripts/verify-release.cjs:256) both the requirement that
a Windows package carry `shadowhost/ShadowHost.exe` **and** the `FORBIDDEN`
pattern for `shadowprobe` (line 279) — the second is only there to keep the
first's neighbour out of the package, and neither has anything to guard once the
directory is gone. Then the housekeeping: the ShadowHost lines in `.gitignore`
(20–32), `.prettierignore:8`, `eslint.config.mjs:29`, and the comments that
reference it in `ci.yml:7`, `FreeRdpBridge.ts:16` and `td_rdp.c:10`.

`-DWITH_SHADOW=OFF` in the two FreeRDP build scripts is **not** this feature —
that is FreeRDP's own shadow *server*, already off, and it stays off.

## 2. The one thing that must survive

`qualifyUser` lives in `shared/winSessions.ts` but is not part of shadowing: an
ordinary RDP login uses it at [`ipc/rdp.ts:45`](src/main/ipc/rdp.ts:45) to turn
`administrator` into `10.10.10.9\administrator`. Deleting the file with the
feature takes out logins to any host that is not in this machine's domain, and
nothing in the pane would say why.

Move it to `src/shared/winUser.ts` with the six cases that cover it from
[`winSessions.test.ts:73–96`](src/shared/winSessions.test.ts:73), and delete the
rest of both files. `WinSession`, `shadowable`, `parseSessions`, `errorCode` and
`shadowArgs` have no reader left.

## 3. Order

Top down, so nothing is ever left importing something that has gone:

1. `GraphicalHost.tsx` — cut the picker and the `joined` branch; delete
   `ShadowView.tsx` and the `.session-pick-*` rules.
2. `ru.ts` — remove the seven entries the picker asked for: lines 486, 487,
   488, 490, 491, 497 (`looking…`, which nothing else uses) and 499.
3. `preload/index.ts`, `ipc-channels.ts` — drop the shadow surface and
   `rdp:listSessions`.
4. `ipc/rdp.ts`, `main/index.ts` — drop the handlers, `shadowCredentials`, and
   the exit hook; delete `ShadowHostBridge.ts` and `WinSessions.ts`.
5. `shared/winSessions.ts` → `shared/winUser.ts` per section 2.
6. `resources/shadowhost/`, `resources/shadowprobe/`,
   `resources/remoteassistance-native/`, `docs/shadow-protocol-research.md`,
   `docs/shadow-rpc-implementation.md`, and the paragraph in
   `docs/ironrdp-channel-gap.md:31` that points at the Rust experiment.
7. `package.json`, `electron-builder.yml`, `verify-release.cjs`, `.gitignore`,
   `.prettierignore`, `eslint.config.mjs` and the three stale comments.
8. Documentation, which is where a removal is usually left half-done:
   - `README.md:462` — the "Deliberately not doing" bullet says joining is
     *offered* but not drawn in a pane. Rewrite it to say it is gone and why,
     rather than deleting it: it is the answer to "why can't I join a session".
   - `docs/terminaldeck-0.13-manual.html` — the section "Присоединиться к уже
     открытой сессии" (~1756–1790) and the sentence at ~1725 that says a joined
     session belongs to whoever is working in it.
   - `HelpDialog.tsx` — checked, it never mentioned the feature. Nothing to do.
   - `CHANGELOG.md` — a **Removed** section under the next version. History
     stays as it is.

## 4. What the tests will catch, and what they will not

`i18n/coverage.test.ts` checks both directions, so a `ru.ts` entry left behind
after step 1 fails the suite by name — step 2 cannot be silently skipped.
Typecheck catches every orphaned import from steps 3–5.

Nothing checks the two that matter most. **The manual and the README are prose,
and no test reads them** — a release can ship a manual describing a feature the
build no longer has, which is what step 8 exists for. And the Windows package
check in `verify-release.cjs` is the reverse trap: leave the ShadowHost
requirement in place and every Windows release fails at the last step, after
three runners have spent their half hour.

## 5. Open, and for the rework to answer

- What the desktop pane says when someone wanted to join a session. Today the
  picker is the second half of that screen; after this it is one button.

  **Left as one button.** Removing the picker is not the place to decide what
  replaces the screen it was half of, and connecting straight through would have
  been a behaviour change smuggled in under a removal. The pane still shows the
  address and **New session**, exactly as it did for anyone who never joined.
- Whether `resources/remoteassistance-native` really goes with this or belongs
  to the rework — it opens an ordinary RDP session and is only related to
  shadowing by how it was researched.

  **Went.** It was an empty directory in the working tree with nothing tracked in
  it, and `docs/ironrdp-channel-gap.md` — the only thing that cited it — now says
  so in the past tense.
