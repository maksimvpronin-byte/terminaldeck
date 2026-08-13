# Research: implementing RDS shadowing in the embedded client

> **Status: research complete.** The sequence is known end to end and the work
> is staged below. Nothing is implemented yet — the shipping path is still
> `mstsc` adopted into the pane.

Today a joined session is drawn by `mstsc`, adopted into the pane by
ShadowHost — see [the commit](../resources/shadowhost/ShadowHost.cs). It works,
and the only thing it cannot do is scale the picture, because the pixels belong
to another process. Implementing shadowing in the client we already embed would
remove both the helper process and that limit.

This note records what is established, so the next session does not start over.

## Settled

**Initiation is documented.** [MS-TSTS] (Terminal Services Terminal Server
Runtime Interface Protocol) defines `RpcShadow2`, the RPC call that starts a
shadow. Its parameters are the target session id, whether the shadower gets
input or only watches, and whether the person there is asked first. The modes
appear in the spec as `Shadow_EnableInputNoNotify`, `Shadow_EnableNoInputNotify`
and `Shadow_EnableNoInputNoNotify` — the same three choices the picker offers.

This matters: it means the hard part is implementing a published specification,
not reverse-engineering a private one.

**The transport for initiation is RPC over SMB.** Established here by
experiment rather than by reading: with port 445 shut the call never completes,
and an unreachable host answers `Ошибка 1722` — `RPC_S_SERVER_UNAVAILABLE`. This
is why shadowing needs file and printer sharing open and ordinary RDP does not.

**There is no separate specification for the shadow display.** [MS-RDSOD], the
overview that lists every Remote Desktop protocol, names MS-TSTS among them and
nothing that would be a shadow-specific display protocol. So the picture is
carried by core RDP — [MS-RDPBCGR] and the graphics extensions — which IronRDP
already implements. That is the encouraging part: what is missing is the
negotiation, not the drawing.

**mstsc does it through a viewer control.** Its shadow window is class
`SrApiViewerAxContainerClass` — an SRAPI (Windows Desktop Sharing API) viewer,
implemented in `rdpviewerax.dll`. Hosting that control ourselves was considered
and rejected: it is **not registered for COM** on a stock Windows 11
(`REGDB_E_CLASSNOTREG`), so using it would mean either changing the user's
machine with `regsvr32` or registration-free activation against an undocumented
CLSID. Neither belongs in an application.

## How the shadower is told where to connect — answered

`RpcShadow2` is opnum 0 on the interface MS-TSTS calls the LSM notification
interface, and the specification is explicit about what it does:

> The RpcShadow2 method will create a shadow session using the **Windows Desktop
> Sharing API** in the target session and **return an invitation** to that
> session.

```c
HRESULT RpcShadow2(
  [in]  handle_t hBinding,
  [in]  ULONG TargetSessionId,
  [in]  SHADOW_CONTROL_REQUEST eRequestControl,      // view or take control
  [in]  SHADOW_PERMISSION_REQUEST eRequestPermission, // ask first, or do not
  [out] SHADOW_REQUEST_RESPONSE* pePermission,        // what the user answered
  [out, string, size_is(cchInvitation)] LPWSTR pszInvitation,
  [in, range(1,8192)] ULONG cchInvitation
);
```

Two things follow, and the second is the expensive one.

**The call blocks on the human.** "The call is synchronous, so if permission is
requested, the call will wait until the user responds." Anything calling this
needs a generous timeout and a way to give up — the person at the far end may
be at lunch.

**What comes back is not a ticket for a connection but an invitation to one.**
It is "a Unicode string in the XML format specified in **[MS-RAI] section
2.2.2**" — Remote Assistance Initiation. So the viewer speaks Remote Assistance,
which is why `mstsc` hosts the Desktop Sharing viewer control rather than
drawing the session with its own RDP client.

That sounded at first like a different protocol carrying the picture. It is not:
the two sections below establish that the invitation names an ordinary RDP
endpoint and that Remote Assistance rides on top of core RDP. Recorded here
because the first reading cost an evening, and the wording of this sentence is
what caused it.

## What the invitation contains — answered

[MS-RAI] Appendix A gives the format. The useful part is one attribute:

```xml
<UPLOADDATA USERNAME="jeff"
  RCTICKET="65538,1,192.168.1.65:3389;jeff_xp:3389,*,<base64>,*,*,<base64>"
  RCTICKETENCRYPTED="1" PassStub="o2*5GdBARK_JBB" DtStart="…" DtLength="60" />
```

The connection string carries **an address and port 3389**, a stub password and
two tokens. So the picture does travel over the ordinary RDP port after all, and
the invitation is what says where and with what.

`DtLength` is worth noting: the ticket is valid for minutes, not indefinitely.
Anything that caches one has to re-request rather than retry.

## How Remote Assistance relates to RDP — answered

[MS-RA] section 1.4 settles it:

> The Remote Assistance Protocol also assumes that underlying protocols,
> specifically **[MS-RDPBCGR]** and **[MS-RDPEGDI]**, will be available to
> **transport the protocol messages** after the basic Remote Assistance
> connection is made.

Remote Assistance is a layer *over* core RDP, not an alternative to it. Its own
messages are a small set of control packets — `REMOTEDESKTOP_CTL_AUTHENTICATE`,
`_VERSIONINFO`, `_SERVER_ANNOUNCE`, `_ISCONNECTED`, `_DISCONNECT` — carried on a
virtual channel, the same mechanism IronRDP already uses for the clipboard and
for file redirection.

That corrects the pessimism of the previous revision. IronRDP is not merely
"not wasted": it does the whole transport, and what is missing is a channel with
a handful of message types on it.

## What has to be implemented, and what does not

[MS-RA] uses four virtual channels, and only one of them is on the path to a
picture:

- **Session initialization** — created with the connection and kept for its
  duration. "This exchange has to be completed successfully for the Remote
  Assistance session to be established. Once the Remote Assistance session is
  established, the expert can view the novice's screen." This one is required.
- **Chat** — also created when the connection is established.
- **File transfer** and **share control / VoIP** — created on demand, for
  capabilities shadowing does not need.

So watching a session needs the RDP connection, one virtual channel, and its
control packets. The screen itself arrives as ordinary RDP graphics, decoded by
code IronRDP already has. Nothing about file transfer, chat or voice is on the
critical path.

The control packets are listed in [MS-RA] section 2.2.1: a channel and packet
header, then `AUTHENTICATE`, `VERSIONINFO`, `SERVER_ANNOUNCE`, `ISCONNECTED`,
`RESULT`, `VERIFY_PASSWORD`, `TOKEN` and the two name packets. A dozen small
structures.

## The plan

1. **Prove the RPC first.** It is the largest unknown and everything else
   depends on it, so it should fail early if it is going to. A standalone call
   to `RpcShadow2` that returns an invitation string is the milestone — no RDP,
   no UI. If this cannot be made to work, nothing after it matters.
2. **Parse the invitation.** Small, and testable against the sample in [MS-RAI]
   appendix A without a server.
3. **Session initialization channel** over IronRDP, against a real host.
4. **Replace ShadowHost** only once a session is actually visible this way. Not
   before: the working implementation is the fallback until it is not needed.

Stages 1 and 2 are testable in isolation, which is the point of that order.

## Estimate

Three pieces, and they are not equal:

- **DCE/RPC client** for `RpcShadow2`. The real cost. Authenticated RPC over
  SMB, which is a protocol stack in its own right.
- **Invitation parser.** Small — XML with one attribute worth reading.
- **Remote Assistance channel.** Bounded: five or so packet types on a virtual
  channel IronRDP already knows how to open.

The shipping implementation — `mstsc` adopted into the pane — stays where it is
until all three exist and are proven against a real host.

## Not worth revisiting

- **FreeRDP, guacd, rdp-rs, the old JavaScript clients.** Each is either native
  code with a per-platform build, or unmaintained, or too incomplete for modern
  authentication. IronRDP is the only actively maintained implementation that
  targets WebAssembly, which is what keeps this app to one installer.
- **Hosting the SRAPI viewer control**, for the registration reason above.

## References

- [MS-TSTS] Terminal Services Terminal Server Runtime Interface Protocol —
  <https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tsts/1eb45af1-94f1-4c42-9e13-dd0a018646fd>
- [MS-RDSOD] Remote Desktop Services Protocols Overview —
  <https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdsod/072543f9-4bd4-4dc6-ab97-9a04bf9d2c6a>
- IronRDP — <https://github.com/Devolutions/IronRDP>
