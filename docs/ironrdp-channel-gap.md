# IronRDP and the Remote Assistance channel

> **Correction, 25 August 2026.** The claim below that the package "covers
> clipboard, CredSSP, file transfer and other built-in capabilities — not
> `RC_CTL` or `remdesk`" is right about *arbitrary* channels, but it was read
> too broadly elsewhere in this project, as "the WebAssembly client has no
> drive or audio support". It does. Pulling the embedded module apart shows
> `ironrdp-rdpdr` and `ironrdp-rdpsnd` compiled into it, alongside
> `ironrdp-cliprdr`, `ironrdp-dvc` and `ironrdp-displaycontrol`. What is genuinely
> absent is `ironrdp-egfx` — the graphics pipeline, and with it H.264 — so the
> client draws from bitmap updates and RemoteFX only. Whether the drive and
> sound channels can be reached from JavaScript is a separate question from
> whether they are there; they are there.

## Where the renderer stands

`@devolutions/iron-remote-desktop-rdp@0.7.0` accepts ready-made extensions, but
exposes no public API for arbitrary RDP static or dynamic virtual channels. The
package types hide `Extension` behind `unknown`, and the list of factory
functions covers clipboard, CredSSP, file transfer and other built-in
capabilities — not `RC_CTL` or `remdesk`.

So `remoteAssistanceProtocol.ts` holds the protocol and the boundary a transport
has to satisfy, rather than pretending a pre-connection blob can stand in for the
channel. It cannot: a pre-connection blob is not a virtual channel.

The Rust crates are a different matter. `resources/remoteassistance-native` does
register `remdesk` as a static channel and speaks the control messages on it,
using `ironrdp-connector` and `ironrdp-svc` directly. The gap is in the
WebAssembly package the renderer embeds, not in IronRDP as a whole.

## What a backend has to provide

An implementation of `RemoteAssistanceChannelTransport` needs to:

1. register `RC_CTL`, or the static `remdesk`;
2. carry channel PDUs in both directions;
3. open channels `70` and `71` after the handshake, for chat and share control.

Until the renderer's client can do that, the shipping path stays `ShadowHost.exe`
running `mstsc /shadow` and adopting its window into the pane. See
[the shadow notes](shadow-rpc-implementation.md) for how far the native client
gets and what has been ruled out.
