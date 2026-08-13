# Research: implementing RDS shadowing in the embedded client

> **Status: in progress.** Enough is settled to say the work is bounded and not
> archaeology. The display half is not yet pinned down, and that is the next
> thing to read.

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

**The picture is not carried by an ordinary RDP connection.** The invitation is
"a Unicode string in the XML format specified in **[MS-RAI] section 2.2.2**" —
Remote Assistance Initiation. So the viewer speaks Remote Assistance, which is
why `mstsc` hosts the Desktop Sharing viewer control rather than drawing the
session with its own RDP client.

This corrects the hopeful reading in the previous section. Core RDP is the
transport underneath Remote Assistance, so IronRDP's decoding is not wasted —
but the connection sequence is a protocol IronRDP does not implement, on top of
one it does.

## Open

**What the Remote Assistance connection sequence requires**, in [MS-RA] and
[MS-RAI]: how the invitation's contents lead to a connection, and how much of it
sits above RDP rather than beside it. This decides whether shadowing is a mode
added to IronRDP's connector or a second connector alongside it.

## Next

1. Read [MS-RA] and [MS-RAI] section 2.2.2, and write the sequence here.
2. Decide where the RPC client lives. Nothing in this codebase speaks DCE/RPC,
   and the renderer is the wrong place for it: it belongs in the main process,
   beside the gateway that already does the network half of RDP. Note that this
   is a real dependency — an RPC client is not a small thing to write, and there
   is no pure-JavaScript one worth having.
3. Only then estimate the IronRDP work, with both sequences in hand.

## Estimate, revised

Larger than the previous note implied. Three pieces rather than one: a DCE/RPC
client for the initiation, an invitation parser, and a Remote Assistance
connector over IronRDP's RDP. The shipping implementation — `mstsc` adopted into
the pane — stays where it is until all three exist and are proven.

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
