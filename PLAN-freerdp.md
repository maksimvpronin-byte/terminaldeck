# Plan: replacing IronRDP with FreeRDP

> **Status: step one passed, on the second attempt; nothing written yet.**
> FreeRDP is decisively better than the embedded pane on the host that prompted
> this — at a matched size, not only in a small window. The premise holds; the
> route does not yet.

## Why

The desktop pane is soft and slow on a 27" screen and unusable on a slow link,
and the ceiling is not a setting. `@devolutions/iron-remote-desktop` 0.11 with
`-rdp` 0.7 — both the latest published, checked against the registry — contains
no graphics pipeline at all. Not disabled: absent. The evidence, from the
client's own WASM:

- the only dynamic channel name in the binary is
  `Microsoft::Windows::RDS::DisplayControl`. `Microsoft::Windows::RDS::Graphics`
  does not appear, so MS-RDPEGFX cannot be opened even in principle;
- `egfx`, `rdpgfx`, `h264`, `avc420`, `avc444`, `progressive` appear zero times;
  `rfx`/`RemoteFx` appear 75 times, and the `ironrdp-graphics` crate contains
  `dwt.rs`, `quantization.rs` and `rdp6/bitmap_stream/decoder.rs` — the wavelet
  and quantisation of RemoteFX, and planar RDP6 bitmaps. The legacy set, whole.

And on the host that prompted this, even RemoteFX does not engage: the server
dictates 16 bits per pixel, and 657 of the 701 runtime log lines were
`Non-32 bpp compressed RLE_BITMAP_STREAM bpp=16`. Run-length encoding of
antialiased text, at 3.7 megapixels a repaint. Nothing above the protocol can
fix that.

FreeRDP has the pipeline: GFX, RemoteFX progressive, H.264 AVC420 and AVC444.

## What this touches, which is less than it looks

**One file imports the client.** `GraphicalHost.tsx` is the only place
`@devolutions/iron-remote-desktop` appears. Whatever replaces it meets the app
at one seam.

**And one much larger thing might be retired.** `TsGateway.ts` (948 lines),
`Gateway.ts` (481), `ntlm.ts` (422) and `md4.ts` (98), with 825 lines of tests,
exist because IronRDP cannot speak to an RD Gateway — so this app implements
[MS-TSGU] itself, both transports, NTLMv2 and channel binding included. FreeRDP
speaks RD Gateway natively.

That is the largest single prize here and the largest risk in the plan. Those
2,400 lines work, are tested, and were expensive; replacing them with someone
else's implementation is right in principle and is a second decision, not a
consequence of the first. Nothing in this plan requires retiring them on the
same day.

## Step one, before any code: prove it

FreeRDP is worth the cost only if it actually fixes the picture on *this* host
over *this* link. That can be known in an hour, with a stock build and no
integration at all:

```
brew install freerdp
xfreerdp /v:HOST /u:USER /gfx:AVC444 /gdi:hw /log-level:INFO
```

What to read from it:

- does the log show the Graphics channel opening and AVC444 or progressive
  being used, or does it also fall back to bitmap updates? If the *server*
  refuses the modern pipeline, FreeRDP changes nothing and this plan ends here;
- is it smooth on the slow link, subjectively, where the current pane is not;
- does 16-bit colour still apply? If the host's colour-depth policy is what
  caps it, that cap survives the client swap.

The same run through the RD Gateway (`/g:GATEWAY`) also tests the second prize
before anything depends on it.

**If FreeRDP is not visibly better on that host, stop.** Everything below costs
weeks and buys nothing.

### What step one found, 2026-08-31

`sdl-freerdp` 3.31 — the SDL client rather than the X11 one, so the rendering
path is comparable — reached the same host through the same RD Gateway over the
same link, and is decisively better than the embedded pane. Reported as such at
a small size and again at a matched one, which is the comparison that counts:
the first run proved nothing, since fewer pixels is less data per repaint
whatever the codec.

It won carrying a handicap. The Homebrew build announces
`WITH_VERBOSE_WINPR_ASSERT=ON` and says of itself that runtime checks "might slow
down the application", so the build argues against FreeRDP rather than for it. A
release build can only be faster.

**So the ceiling was the client**, not the link and not the host. That is the
finding this plan needed, and it is the one thing here that had to be true.

The judgement is subjective — one person, one host, one afternoon. It is enough
to justify the next step, which is itself a measurement rather than a
commitment, and not enough to justify skipping it.

**Which pipeline it negotiated was not settled, and is parked.** At `INFO`
FreeRDP says nothing about codecs, and `/log-filters` with per-tag `DEBUG` did
not take — the capture came back with zero `DEBUG` lines, so it was an empty log
being read rather than a quiet one. Chasing it further was not worth the rounds:
it changes how much work the shim is, not whether to do it.

It can be settled in one run whenever anyone wants it, without reading a log at
all — connect with `-gfx` and see whether it gets worse. Worse means the
graphics pipeline was doing the work and the shim must carry it, decoder
included. No difference means the protocol was never the problem, the
implementation was, and the shim is a much smaller thing.

Whoever writes the shim will know within a day regardless, from FreeRDP's own
source. This is a question better answered by code than by guessing at logs.

## The three routes, if step one passes

**A. guacd.** Bundle Apache Guacamole's daemon; it drives FreeRDP and streams
to the renderer over its own protocol, drawn by `guacamole-common-js`.
*For:* no protocol code of ours at all.
*Against:* a C daemon and its dependency chain — cairo, libjpeg, libpng,
libwebp, FreeRDP — built for macOS, Windows and Linux. And guacd decodes and
re-encodes into image updates, so H.264 reaches guacd but not the canvas; the
network leg to the host is the one that improves, which is the leg that matters,
but the local cost is real.

**B. A FreeRDP shim of our own.** A small headless client: connects, decodes,
writes frames into shared memory, and speaks a minimal protocol to the main
process over a socket; the renderer draws them.
*For:* no re-encoding, we own the surface and the input path.
*Against:* we own a native binary. FreeRDP's client API is not small, and
input, clipboard, resize and file transfer all have to be plumbed by hand.

**C. A native Node addon.** As B, but in-process.
*Against:* ABI-coupled to Electron's Node version, and a crash in the decoder
takes the window with it.

**Recommended: B**, and the codebase agrees. `electron-builder.yml` already
ships a compiled helper — `ShadowHost.exe`, built by `resources/shadowhost/
build.ps1` and carried in `extraResources` — so the app already knows how to
bundle a binary and talk to it out of process. B is that pattern again, and it
keeps a decoder crash out of the window. C is the same work with worse
failure modes.

**The real cost in all three is not the glue.** It is building and shipping
FreeRDP for three platforms and keeping it built. The existing precedent is one
`.exe` compiled on the Windows runner from a single C# file; FreeRDP is a
different order of thing.

## What is lost on the way

Clipboard and file transfer currently ride on `iron-remote-desktop`'s
extensions, and the shadowing path (`ShadowHostBridge`) is separate and
unaffected. Both would have to be rebuilt against FreeRDP's own channels. The
sizing work in `shared/desktopSize.ts` survives — it computes what to ask for,
not how to ask.

## Where this stands, and what is next

Step one is passed. The route is undecided, and the honest order of work is:

1. **Get FreeRDP building for macOS, Windows and Linux from CI, and keep it
   built.** This is the dominant cost of every route, it is entirely independent
   of the glue, and it is the thing most likely to sink the plan. Doing it first
   means finding that out before writing a line of integration.
2. Only then the shim, route B, against a build that already exists.
3. The RD Gateway question — whether the 2,400 lines of MS-TSGU here are retired
   in favour of FreeRDP's — stays a separate decision, taken after the shim
   works with them still in place.

## Open questions, to answer before committing
- Does the 16-bit colour cap survive the client swap? Almost certainly yes; the
  policy is on the host.
- Licensing: FreeRDP is Apache 2.0, guacd likewise. Compatible, and the
  attribution obligations need writing down.
- Windows and Linux builds: this app releases all three from CI. FreeRDP has to
  build there too, or the desktop pane becomes macOS-only, which is worse than
  what we have.
