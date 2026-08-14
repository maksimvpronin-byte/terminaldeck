# Embedded shadow: what is built, and what has been ruled out

The shipping path is still `mstsc` adopted into the pane by ShadowHost. This
note records how far the embedded client got and, more usefully, which
explanations for its failure have been tested and eliminated — so the next
session does not spend an evening re-testing them.

## The initiation works

`WinStationRcmShadow2` was tried first and abandoned: it returns `S_OK` and
`ALLOW` but an empty output buffer in both buffer and pointer ABI variants.

The working route is the public Session Environment RPC, implemented by
`resources/shadowprobe/SessEnvProbe.c`:

- interface UUID `1257B580-CE2F-4109-82D6-A9459D0BF6BC`, version `1.0`
- transport `ncacn_np`, endpoint `\\pipe\\SessEnvPublicRpc`
- method `RpcShadow2`, opnum `0`

It returns `HRESULT=0x00000000`, `response=ALLOW` and a 1352-character Remote
Assistance Connection String 2. Two things were needed to get there: the binding
must carry authentication info (`RpcBindingSetAuthInfoW`), or the endpoint sees
an anonymous caller and answers `5`; and the call must be made on the target
itself, which `run-remote.ps1` does over WinRM.

`RpcShadow2` also reports what the host's policy made of the request, in an out
parameter that is easy to discard. Read it: an invitation can arrive alongside a
refusal.

## The connection reaches the session and is then dropped

`resources/remoteassistance-native` connects to the listener named by the
invitation and completes the whole RDP sequence — X.224, TLS, MCS, licensing,
capability exchange. The server then sets up `drdynvc`, creates an `ECHO`
dynamic channel, and sends an MCS Disconnect Provider Ultimatum.

Two measurements narrow this a great deal:

**The verdict predates the active stage.** A capture shows the server sending
the DVC capabilities request, the `ECHO` create request and the ultimatum in one
burst, 2.5 ms after the connection finalizes. It never waited for a reply. So
nothing the client does after connecting can affect the outcome.

**The visible part of the connection is now identical to the working client.**
A capture of `mstsc /v:<host> /shadow:<id>` against the same listener was
compared with ours packet by packet. Both use the same dynamic port, the same
`RDP_NEG_REQ`, and the server selects `PROTOCOL_SSL` for both. The one
difference was that IronRDP appends `Cookie: mstshash=<username>` to the X.224
Connection Request whenever the credentials name a user, with no way to turn it
off; the reference sends a bare 19-byte request. That is now matched.

Everything that remains differs only inside TLS, and `mstsc` uses Schannel,
which does not export its keys. Observation has been exhausted.

## Eliminated

Each of these was a plausible reading of a specification, each was implemented
and tested against a live host, and each left the trace byte-for-byte unchanged:

| Explanation | How it was ruled out |
| --- | --- |
| The expert must speak first on `remdesk` | Implemented per [MS-RA] section 3; no change. The first run sent nothing at all on `remdesk` and died identically, which alone shows the channel is not involved. |
| The auth string must ride in `WorkingDir` of the Client Info PDU | Implemented per [MS-RA] 2.2.7.2, along with `*` in `AlternateShell` and `Password`; no change. |
| The host forbids shadowing | Read from the registry: `ShadowPolicy = 2` (full control, no consent), the account is a local administrator, `LocalAccountTokenFilterPolicy = 1`, the WinRM token is elevated. |
| The invitation dies with the process that asked for it | `SessEnvProbe --hold` keeps the caller alive while the expert connects; no change. |
| Consent was never granted | `RpcShadow2` answers `ALLOW` both silently and when asking, and a prompt accepted by hand changed nothing. |
| The client sends a cookie the reference does not | Removed, and the request now matches the captured reference byte for byte; no change. |

Two earlier readings of the trace were wrong and are recorded so they are not
repeated: the ultimatum's reason field is `provider-initiated`, not
`channel-purged` — the enumeration is packed across the two bytes — and it
carries no diagnostic weight either way. And no Server Deactivate All PDU is
ever sent, so the client ignoring that output is not the cause.

## Where a target must be before any of this means anything

Most of the evening above was spent against session 1 of a host, which was
`Disconnected`. `RpcShadow2` answers for such a session with a listener that has
nothing behind it, so the connection completes and is dropped no matter what is
sent. Only a session that is `Active` with a signed-in user can be shadowed.

`shadow-connect.ps1` now refuses to proceed otherwise, and `SessionList.ps1`
reads the state through `WTSEnumerateSessions` rather than parsing `qwinsta`,
whose status words are localised and whose output arrives through WinRM in the
console OEM code page.

## What is left to try

Only the fields the capture cannot show, and only as guesswork: the client
identifies itself with `client_build: 0`, a made-up `client_name`, an empty
`dig_product_id` and no keyboard layout, none of which a real client would send.
`mstsc` also joins nine MCS channels where this client joins eight.

A better answer than guessing would be an open implementation of the version 2
expert side to compare against. FreeRDP's `remdesk` client covers the control
channel but was written for the invitation-file flow, not for shadowing.
