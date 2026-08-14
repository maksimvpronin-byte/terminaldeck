# ShadowProbe

Standalone probe for the Windows `WinStationRcmShadow2` wrapper.

Build from PowerShell on Windows:

```powershell
./build.cmd
```

Resolve exports without contacting a host:

```powershell
./ShadowProbe.exe --resolve
```

Request a view-only invitation for an existing session:

```powershell
./ShadowProbe.exe --call 3 server-name
```

The optional argument `control` requests keyboard and mouse control. Permission
is requested silently, so shadowing never stops to collect a click; pass `ask` to
prompt the person at the far end instead. Both were tried against this host and
both answer `ALLOW`, so consent is not what stands between the probe and a
working session.

`RpcShadow2` reports what the policy made of the request in its own output
(`response=`), and an invitation can come back alongside a refusal, so read that
line before trusting the invitation.

Run it on the remote host, which is required when the local Windows account is
not an administrator there:

```powershell
./build.cmd
./run-remote.cmd -ComputerName 10.10.10.9 -SessionId 3
```

First verify the session under the same credentials:

```powershell
./run-remote.cmd -ComputerName 10.10.10.9 -List
```

Use only a session shown as `Active` with a logged-on user. `services`,
listeners, and disconnected sessions are not valid shadow targets.

The wrapper prompts for credentials itself. A `$cred` object cannot be passed
through a `.cmd` boundary; to reuse one, invoke the `.ps1` with
`powershell.exe -ExecutionPolicy Bypass -Command` in the same PowerShell
process.

The `.cmd` wrappers use process-level `ExecutionPolicy Bypass`, so the machine's
PowerShell policy does not need to be changed. Direct `.ps1` execution can also
be used with `powershell.exe -ExecutionPolicy Bypass -File ...`.

The script asks for credentials if `-Credential` is not supplied. It uses
WinRM, copies the probe to a random temporary filename, runs it on the target,
and removes it afterwards. The target needs PowerShell remoting enabled and,
for a workgroup host, the local machine must trust it via `TrustedHosts`.
The runner explicitly bypasses the configured HTTP proxy for this local WinRM connection;
use `-UseSsl` if the target exposes only the HTTPS WinRM listener.
If the normal call reports `S_OK` but an empty invitation, retry with
`-PointerAbi`; this tests the alternate `LPWSTR*` wrapper ABI.

The next native RPC stage uses `SessEnvPublicRpc.idl`. Install the Windows SDK
to obtain `midl.exe`, then generate the proxy/stub sources with:

```powershell
./build-rpc-dev.cmd
```

This creates `SessEnvProbe.exe`, the direct `SessEnvPublicRpc` client. Run the
remote wrapper only after this build has succeeded.
