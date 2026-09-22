# Plan: RDP through an RD Gateway, and the rest of what Windows App does

> **Status: sections 0 to 3 are done; the gateway path is untested against a
> real gateway.** Written up before any code, from a
> reading of the current RDP path on 2026-08-25. The target is being able to
> reach a work machine that sits behind a Remote Desktop Gateway — today the
> only supported route is a direct TCP dial to `host:3389`.

Written in English to match `PLAN.md`, `README.md` and `docs/`.

---

## Where this starts from

What already works, and is worth not breaking:

- `GraphicalHost.tsx` embeds IronRDP compiled to WebAssembly and draws the
  desktop in a pane. No native dependency, one installer per platform.
- `main/rdp/Gateway.ts` impersonates a Devolutions Gateway on loopback, because
  the WASM client refuses to dial an RDP server directly. It performs the X.224
  exchange, brings up TLS, and reports the server's certificate chain back —
  the client needs the chain because CredSSP binds to the server's public key.
- Credentials resolve through the vault (`rdp:credentials`), a domain travels
  in the username as `DOMAIN\user`.
- Clipboard both ways, plus file transfer through the clipboard channel.
- Dynamic resolution: the pane's size is pushed with `interaction.resize`,
  clamped to the 200–8192 range [MS-RDPEDISP] takes.
- Session listing and shadowing, on a Windows host only.

Two facts about the code shape that decide most of this plan:

1. **`openTcp(host, port)` in `Gateway.ts` is the only place that decides how to
   reach the server.** Everything above it — X.224, TLS, the certificate chain,
   RDCleanPath — is written against a duplex stream. Gateway support is a
   replacement for that one function, not a rewrite.
2. **A host carries no RDP settings at all.** `SessionProfile` has `protocol`
   and `host`; every other parameter is hardcoded in `connect()` in
   `GraphicalHost.tsx`. There is nowhere to put a gateway address today.

---

## What was verified, so it is not re-checked later

- `@devolutions/iron-remote-desktop-rdp@0.7.0` is the **latest published
  version**. Its public API exposes extensions for: clipboard, CredSSP, file
  transfer, printer, `displayControl`, `kdcProxyUrl`, `preConnectionBlob`.
  There is **no `rdpdr` (drives) and no `rdpsnd` (audio)**, and no API for
  arbitrary static or dynamic virtual channels — the same gap
  `docs/ironrdp-channel-gap.md` already records for the Remote Assistance
  channel.
- The Rust side does have them: `ironrdp-rdpdr` 0.7.0, `ironrdp-rdpdr-native`
  0.7.0, `ironrdp-rdpsnd` 0.9.0, `ironrdp-rdpsnd-native` 0.7.0 on crates.io.
  The gap is in the WebAssembly wrapper, not in IronRDP.
- **`ironrdp-mstsgu` 0.0.1 exists** — "Terminal Services Gateway Server
  Protocol", published 2026-07-10 from the IronRDP repository. So upstream is
  implementing MS-TSGU, at the very earliest stage, in Rust.
- `crypto.createHash('md4')` **fails on this machine** (Node 22.23.1):
  `error:0308010C:digital envelope routines::unsupported`. OpenSSL 3 moved MD4
  to the legacy provider. NTLMv2 cannot be computed without MD4. See 2b.
- `startTls` passes `rejectUnauthorized: false`. Any certificate is accepted
  silently, including a substituted one.

---

## 0. Establish which gateway this actually is — **done**

Read out of Windows App's own store, `com.microsoft.rdc.application-data.sqlite`.
One saved connection, used 65 times, so this is the live setup:

| | |
|---|---|
| Host | `pronin.nsd.ru` |
| Gateway | `rdg.nsd.ru`, default port |
| Gateway credential | none of its own — the connection's login is used |
| `gatewayusagemethod` | `2`, gateway when a direct connection fails |
| `enablecredsspsupport` | `1` |
| `enablerdsaadauth` / `targetisaadjoined` | `0` / `0` |
| `use multimon` / `screen mode id` | `1` / `2` — full screen across every monitor |
| Redirection | clipboard, printers, smart cards; **no drives** |
| Audio | played locally, **microphone redirected** |

What that settles:

- **Entra ID and AVD are out.** A classic on-prem gateway with domain
  authentication, so section 2b is NTLM or Kerberos and nothing else.
- **Drives are not actually used**, and the microphone is. Section 5's ordering
  was backwards: audio matters here and is the harder of the two.
- **Multi-monitor is in daily use**, which section 4 cannot deliver. That is a
  real regression against Windows App and has to be said out loud rather than
  discovered.

The original reasoning is kept below.

Half an hour, and it sets the size of section 2. Guessing here is expensive.

Three things to determine:

- **Transport** — the WebSocket endpoint `wss://gw:443/remoteDesktopGateway/`
  that Windows App uses against Server 2016 and later, or the older
  RPC-over-HTTP pair (`RDG_IN_DATA` / `RDG_OUT_DATA`).
- **Authentication on the gateway** — NTLM, Negotiate/Kerberos, Basic, or a
  smart card.
- **Bypass** — whether some addresses are meant to skip the gateway.

Windows App is installed on this Mac; its saved connections live under
`~/Library/Containers/com.microsoft.rdc.macos` and state all three. Reading
them is the fastest route to an answer. A `.rdp` file exported from the work
setup says the same thing in plain text.

---

## 1. RDP settings on a host — **done**

Landed as described: `RdpDefaults` in `shared/types.ts`, resolved by
`shared/rdpResolution.ts` along the same walk as the login, one `RdpFields`
component shared by the session, group and inventory-override dialogs, and the
gateway password threaded through the save path beside the existing one.

Two things worth recording that the plan did not anticipate:

- **The gateway login travels with the gateway that names it.** Picking the
  fields independently would let a host inherit one gateway's address and
  another's password, which fails as a wrong password and says nothing about
  why. `resolveRdp` picks the whole credential from the level that states the
  host.
- **⌘ as Ctrl had to be done by rewriting events.** The client turns
  `KeyboardEvent.code` into a scancode through a fixed table with no hook in it,
  so `useCommandAsControl` intercepts on `window` in the capture phase, ahead of
  the client's own bubble-phase listener. It also has to synthesise the key
  release macOS withholds while ⌘ is held, or the far side keeps the key down.

`reserve()` now takes a host id and the route is settled in the main process, so
a gateway password never crosses into the renderer. Until section 2 lands, a
configured gateway makes the connection fail with a message saying so — the one
line in `Gateway.ts` to delete when the transport exists.

Two to three days. No protocol work, no risk, and section 2 cannot land
without it — there is currently nowhere to type a gateway address.

### Data model

A new `RdpDefaults`, inherited down the same chain as `AuthDefaults` — host,
then group, then inventory repository — so one gateway is configured once for a
whole group:

- `gatewayHost`, `gatewayPort`
- `gatewayUsername`, `gatewaySecretRef` — the gateway login is frequently not
  the host login; the secret goes in the vault like every other one
- `gatewayBypassLocal`
- resolution: fit the pane (today's behaviour) or a fixed width and height
- Mac keyboard mapping (Cmd to Ctrl, and what happens to the function keys)

Protocol stays non-inheritable, as `protocols.ts` explains. These fields
inherit, because a gateway is a property of where a machine lives.

### Wiring

`rdp:reserve` takes no argument today, but the gateway has to be known *before*
a socket is opened. It becomes `reserve(sessionId)`, with the settings resolved
in the main process — the same shape `rdp:credentials` already uses, and it
keeps the resolution out of the window.

### UI and docs

`SessionDialog`, plus the inventory override dialog. Then `HelpDialog`,
`README.md` and `CHANGELOG.md` in the same change: a feature that is not in the
help and the README has not landed.

---

## 2. MS-TSGU — the gateway itself — **written, not yet proven**

Landed as five pieces:

| File | What it is |
|---|---|
| `main/rdp/md4.ts` | MD4, since OpenSSL 3 withdrew it and NTLM cannot be computed without it |
| `main/rdp/ntlm.ts` | NTLMv2: the three messages, the MIC, the channel binding, RC4 for the session key |
| `shared/tsgu.ts` | The tunnel PDUs — handshake, tunnel, authorisation, channel, data — and what each error code means |
| `shared/wsframe.ts` | Client-side WebSocket framing |
| `main/rdp/TsGateway.ts` | The sign-in, the upgrade, and the tunnel as a duplex stream |

`reach()` in `Gateway.ts` now returns a `Duplex` rather than a `Socket`, which
is the whole of the change above it: X.224, TLS and the certificate chain were
already written against a stream and do not know they are in a tunnel.

What the writing turned up that the plan did not:

- **`ws` could not be used.** The upgrade has to be the *second* request on an
  already-authenticated connection, and `ws` opens its own socket and sends its
  own request. Framing is hand-rolled in `wsframe.ts` instead.
- **Channel binding is not optional in practice.** A gateway with Extended
  Protection refuses an unbound sign-in with the same "access denied" it gives a
  wrong password, so `tls-server-end-point` is always computed rather than only
  when something asks.
- **A packet can arrive before anything waits for it** — bytes carried over from
  the upgrade, or an answer landing between two steps. The first version dropped
  those, and the handshake then waited forever for a response it had already
  been given. Found by the stand-in-gateway test, not by reasoning.
- **Only NTLM.** A gateway offering only Kerberos through SPNEGO is reported as
  exactly that rather than as a refused password. SPNEGO is the next thing to
  write if this one turns out to need it.

**What the first real attempt turned up** (25 August, against `rdg.nsd.ru`):

- The connection was reset with `ECONNRESET`, and the pane said only "General
  failure — not enough bytes" until the reason was carried out of the main
  process. The client never shows a close reason, so **every gateway fault
  looked identical** before that was fixed.
- **A fresh `RDG-Connection-Id` per request was wrong.** The gateway keys the
  half-finished sign-in by that header, so the request carrying the answer
  arrived as an unrelated one. One id now covers the whole exchange, which is
  what FreeRDP does.
- The authenticate message wrote a version field **without declaring the flag
  that says it is there**, which a server may read as something else.
- An unauthenticated probe established that the connection does survive the
  first 401 and answers a second request on the same socket, so keep-alive was
  never the problem.

**What the sign-in turned out to be** — settled by experiment on 25 August,
against the live gateway and without ever handling the real password:

| Test | Result |
|---|---|
| Our own module, fake credentials, correct channel binding | `401 Access Denied` |
| Same, with a *wrong* channel binding | connection reset |
| Same, with *no* channel binding | connection reset |
| Empty / domainless / `user@domain` credentials | `401`, never a reset |
| In the app, a **deliberately wrong** gateway password | `401`, reported cleanly |
| In the app, the **correct** password | connection reset |

Read together these say something precise. The gateway resets exactly when the
authenticate message is unacceptable, and answers `401` when it is well formed
but wrong — so a clean `401` on a wrong password proves **our message is
correct and the channel binding is right**. A reset on the *correct* password
therefore happens **after the sign-in has succeeded**, on whatever is asked of
the gateway next.

The remaining explanation is that this gateway does not perform the WebSocket
upgrade, and wants the older RPC-over-HTTP transport: two connections,
`RDG_OUT_DATA` carrying gateway-to-client and `RDG_IN_DATA` carrying
client-to-gateway. Section 2a decided not to write that until something needed
it. Something needs it — and it is now written.

**The older transport** (section 2f): `shared/httpChunks.ts` for the chunk
encoding, `PacketReader` in `shared/tsgu.ts` because packets no longer arrive
one to a frame, and a `TunnelWire` seam in `TsGateway.ts` so the tunnel itself
is identical over either. The WebSocket path is tried first and the fallback is
automatic. Two things the specification mentions in passing and nothing works
without: both connections must carry **the same** `RDG-Connection-Id`, and the
gateway sends a short run of random bytes before the first packet, which is read
as a corrupt header if it is not dropped.

**What the working client's own log said.** Windows App keeps a log inside its
container, and against this gateway it records the same thing this app sees:

    websocket was never opened, treating it as a failed websocket upgrade
    websocket closed with std::exception: Connection reset by peer (Error Code: 54)

So the reset on the upgrade is what this gateway does to everyone, and
Microsoft's client falls back without complaint — `lsof` confirms it then holds
two connections. Chasing that reset was chasing the wrong thing. What remains is
the older transport's own sign-in being dropped at the moment it succeeds, which
is the shape of Windows binding HTTP authentication to a connection over TLS
1.3; hence the capped retry.

**Proven against the real gateway on 25 August**: a desktop behind
`rdg.nsd.ru` opens in a pane. What finally carried it was the shape of the
authenticate message rather than the transport — see the variants in
`TsGateway.ts`. The NTLM values are checked against
the worked example in [MS-NLMP] 4.2.4 and the tunnel handshake against a
stand-in that answers every step and every refusal, but nothing here has met
`rdg.nsd.ru`. `TERMINALDECK_RDP_TRACE=1` reports each step.

The original estimate and reasoning:

One and a half to three weeks. This is the work.

### 2a. Transport

`wss://gateway:443/remoteDesktopGateway/` with the HTTP upgrade. `ws` is
already a dependency and its client half is available. The RPC-over-HTTP pair
is only worth writing if section 0 says the gateway is old enough to need it.

### 2b. Authentication

Usually NTLMv2 over HTTP, negotiated through `WWW-Authenticate`.

The concrete trap, already confirmed above: **`md4` is unavailable in this
Node**, and NTLMv2 needs it for NTOWFv2. Either a pure-JS MD4 — around sixty
lines — or a dependency. Budget it in the first day rather than discovering it
in the middle of the handshake.

If section 0 reports Kerberos-only or a smart card, stop and re-plan: that is a
different piece of work. (`kdcProxyUrl` in the client is for CredSSP against
the target host, not for signing in to the gateway.)

### 2c. Tunnel

`HTTP_CAPABILITY_TYPE`, `TUNNEL_CREATE`, `TUNNEL_AUTHORIZE`, `CHANNEL_CREATE`,
then the data stream. The existing X.224 and TLS sequence runs inside that
stream unchanged.

### 2d. Shape of the change

`openTcp` becomes a transport factory — direct TCP, or through the gateway —
returning something the rest of `run()` can already use. Nothing else in
`Gateway.ts` should need to know which one it got.

### 2e. Tests

`src/shared/rdcleanpath.test.ts` is the model: encode and decode each PDU and
assert on the bytes, with no live server involved. The tunnel PDUs get the
same treatment.

### On not using `ironrdp-mstsgu`

It is Rust, so adopting it means a native sidecar built for every platform —
precisely the cost the WebAssembly client was chosen to avoid, and it would
undo the single self-contained installer. At 0.0.1 it is also too young to
depend on. Read it as a reference implementation; do not link against it.

---

## 3. Server certificates — **done**

`main/rdp/CertificateTrust.ts` holds the store and the dialog;
`main/rdp/certificateVerifier.ts` is the seam the two TLS call sites ask
through, because both are covered by tests that run under plain Node and
importing Electron there fails at load time. The main process installs the real
implementation at startup.

One change from the plan, prompted by what section 0's probe found:
`rdg.nsd.ru` presents a **publicly valid GlobalSign certificate**, not a
self-signed one. So this does not pin the way `KnownHosts` pins an SSH key —
pinning a public certificate would turn its next routine reissue into a
warning that looks like an attack. Instead the system's own verdict is taken
first, and only a certificate the machine cannot verify becomes a question, an
entry, and a warning if it later changes.

Refusal stops the session. There is no path that falls back to connecting
anyway, and the default with no verifier installed is to refuse.

The original reasoning:

Half a day, and worth doing while the gateway work is fresh.

`rejectUnauthorized: false` accepts anything. The app already has the right
pattern for this in `main/ssh/KnownHosts.ts`: prompt on first contact, store
the fingerprint, warn loudly when it changes, allow review and revocation. Do
the same for the RDP server's certificate, and for the gateway's.

---

## 4. Full screen and monitors

Three to five days for the part that is possible.

- **Full screen, and the pane in a window of its own** — app-side only. One
  canvas, and the resize path already works.
- **Real multi-monitor is not available.** It needs a monitor layout supplied
  during the connection sequence, and the WASM client does not expose one. The
  honest maximum today is a single canvas stretched across the combined area.
  Say so in the README rather than half-implementing it.

---

## 5. Drive redirection and audio — **the premise was wrong**

Taking the embedded module apart on 25 August shows `ironrdp-rdpdr` and
`ironrdp-rdpsnd` **compiled into the WebAssembly client**, along with
`ironrdp-cliprdr`, `ironrdp-dvc` and `ironrdp-displaycontrol`. The conclusion
below — reached from the package's public API — was that they were absent. They
are not; what is absent is a documented way to switch them on, which is a much
smaller problem than a missing implementation.

What is genuinely missing is `ironrdp-egfx`: no graphics pipeline and so no
H.264, which is what limits how fast a desktop can be drawn. That one really is
upstream.

Audio matters more than drives here — the Windows App settings redirect the
microphone and no drives at all — so audio is where to look first.

### The original conclusion, kept as the record of a wrong turn

## 5. Drive redirection and audio — blocked upstream

Not schedulable as ordinary work. The channels are absent from the WASM
package, so the options are:

1. A pull request to IronRDP exposing `rdpdr` and `rdpsnd` through the
   WebAssembly client.
2. A fork of the wasm package built in-house — Rust and `wasm-pack` enter the
   build, and the fork has to be maintained.

Both are weeks, and option 2 gives up the property the whole RDP feature was
built around.

**What works today instead:** file transfer through the clipboard channel —
copy in Finder, paste inside the session, and back. For carrying a file to work
and home again this is usually enough. Audio has no workaround.

---

## Suggested order

0 → 1 → 2 → 3. Those four produce a working connection to a machine behind the
gateway, which is the point of the exercise. Only then decide about 4, and
treat 5 as a separate decision about maintaining a fork rather than as the next
task in a list.

## Decisions taken

- **The gateway is implemented in TypeScript, in the main process.** No native
  sidecar, no external service, one installer — the same rule that produced the
  loopback gateway in the first place.
- **Gateway settings inherit; the protocol does not.** A gateway describes
  where a machine lives, which a group can speak for. The protocol describes
  what a machine is, which it cannot.
- **Multi-monitor is refused, not deferred.** Nothing in the current client can
  express it.
- **Drives and audio are upstream work**, recorded here so the next reading of
  this file does not re-investigate the WASM package.
