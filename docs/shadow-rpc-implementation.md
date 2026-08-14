# Embedded shadow: how far it gets, and what has been ruled out

The shipping path is still `mstsc` adopted into the pane by ShadowHost. This
note records how far the embedded client gets and, more usefully, which
explanations have been tested and eliminated — so the next session does not
spend a day re-testing them.

## The initiation works

`WinStationRcmShadow2` was tried first and abandoned: it returns `S_OK` and
`ALLOW` but an empty output buffer in both buffer and pointer ABI variants.

The working route is the public Session Environment RPC, implemented by
`resources/shadowprobe/SessEnvProbe.c`:

- interface UUID `1257B580-CE2F-4109-82D6-A9459D0BF6BC`, version `1.0`
- transport `ncacn_np`, endpoint `\\pipe\\SessEnvPublicRpc`
- method `RpcShadow2`, opnum `0`

It returns `HRESULT=0x00000000`, `response=ALLOW` and a 1352-character Remote
Assistance Connection String 2. Two things were needed: the binding must carry
authentication info (`RpcBindingSetAuthInfoW`), or the endpoint sees an anonymous
caller and answers `5`; and the call must be made on the target itself, which
`run-remote.ps1` does over WinRM.

## The client itself is sound

`resources/remoteassistance-native` opens an ordinary RDP session against port
3389 with `--logon`: CredSSP, capability exchange, fast-path graphics, ECHO
keepalives, a session that stays up for as long as it is left alone. That
control took a day too long to run, and it retired several suspicions at once —
`client_build: 0`, an invented client name, an empty product id, a zero keyboard
layout and the whole channel list are all accepted by a real server.

So what fails is specific to the shadow listener.

## Where the shadow connection now stops

Against the listener named by an invitation, the client completes the whole
connection sequence and the server then ends it. Three findings moved that
stopping point forward, each drawn from evidence rather than from a reading:

**The X.224 request carried a cookie.** IronRDP appends `Cookie: mstshash=<user>`
whenever the credentials name a user, with no way to turn it off. A capture of a
working `mstsc /shadow` against the same listener shows a bare 19-byte request.
Matched, byte for byte, and covered by a test.

**The client never announced the graphics pipeline.** A shadow listener hands its
picture over [MS-RDPEGFX] and has nothing else: the client-side RDP log records
`0xA0600` — `RDPGFX_CAPVERSION_10_6` — for every session that works. A client is
asked about this once, through `RNS_UD_CS_SUPPORT_DYNVC_GFX_PROTOCOL` in
TS_UD_CS_CORE, and IronRDP's connector never sets it. With the flag set, the
server began creating `Microsoft::Windows::RDS::Graphics` — the first change in
its behaviour after a day of identical traces.

**The capability advertise was unwrapped.** Everything on the graphics channel
travels inside a ZGFX segment. `ironrdp-egfx` 0.3.0 wraps outgoing PDUs on its
server side — "Windows clients expect this wrapping on the EGFX DVC" — and sends
them bare from its client side. A Windows server expects it just the same. The
graphics channel here is driven by a local processor for that reason, with
`wrap_uncompressed` from `ironrdp-graphics`; the `e0 04` prefix is visible on the
wire.

After all three, the server still ends the session shortly after the advertise.

## Eliminated

Each of these was a plausible reading, each was implemented and tested against a
live host, and each left the trace byte for byte unchanged:

| Explanation | How it was ruled out |
| --- | --- |
| The expert must speak first on `remdesk` | [MS-RA] 3.5.5 says the opposite — the novice sends SERVER_ANNOUNCE and VERSIONINFO, and each draws its own reply. The first run sent nothing at all on the channel and died identically. |
| The auth string must ride in `WorkingDir` | Implemented per [MS-RA] 2.2.7.2 with `*` in AlternateShell and Password; no change. Then every field was emptied as a control, also no change, which excludes the contents of the Client Info PDU entirely. |
| The host forbids shadowing | `ShadowPolicy = 2`, the account is a local administrator, `LocalAccountTokenFilterPolicy = 1`, the WinRM token is elevated. |
| The invitation dies with its creator | `SessEnvProbe --hold` keeps the caller alive across the connection; no change. |
| Consent was never granted | `RpcShadow2` answers `ALLOW` silently and when asking, and a prompt accepted by hand changed nothing. |
| The control channel has the wrong name | [MS-RA] 3.5.3 names `RC_CTL` where FreeRDP uses `remdesk`. Both are registered, both are granted, neither ever speaks. |
| The channel list is too short | `mstsc` joins nine MCS channels; with `RC_CTL` added this client joins nine too. No change. |
| The target session's rendering pipeline | Shadowing a session created by this client, which negotiates no graphics pipeline at all, fails the same way. The test was worth little: it varies how the *target* session draws, not how the listener hands frames to the expert. |

Two earlier readings were wrong and are recorded so they are not repeated. The
ultimatum's reason field is `provider-initiated`, not `channel-purged` — the
enumeration is packed across two bytes — and carries no diagnostic weight. And
no Server Deactivate All PDU is ever sent, so ignoring that output is not the
cause.

## The target stops behaving consistently

After roughly twenty-five shadow requests in a day, the same client bytes
produce different server behaviour: the graphics channel is created on some runs
and not on others, the listener port stops changing between invitations, and
even the server's own DVC capabilities request changed shape between two runs.
Logging the session off and back on helps for a while.

Nothing can be measured on a target in that state. Any run of a new build has to
be repeated at least three times, on a freshly signed-in session, before its
result means anything — and the open question below could not be measured at all
for this reason.

## What is open

Whether the listener will hold a session for a client that declares AVC off. The
log of a working session records "AVC available: 1", and a listener that can only
encode AVC has nowhere to put a frame for a client that refuses it. `--claim-avc`
says AVC is supported so the question can be settled in one command; the frames
would arrive undecodable, which is enough to tell. `ironrdp-egfx` has an
`openh264` feature if a decoder turns out to be needed.

## Where the target has to be

Only a session that is `Active` with a signed-in user can be shadowed. RpcShadow2
answers for a merely `Disconnected` one with a listener that has nothing behind
it, which completes an RDP handshake and then drops it — a day of the above was
tested against exactly that before anyone checked. `shadow-connect.ps1` now
refuses to proceed otherwise, and `SessionList.ps1` reads the state through
`WTSEnumerateSessions` rather than parsing `qwinsta`, whose status words are
localised and whose output arrives through WinRM in the console OEM code page.
