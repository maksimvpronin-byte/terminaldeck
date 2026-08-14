# Remote Assistance native helper

This is the first native milestone for embedded Remote Assistance:

- The default connection path uses the Remote Assistance RDP endpoint and
  performs the basic RDP/TLS negotiation.
- The Client Info PDU carries what [MS-RA] section 2.2.7.2 requires of it: the
  auth string identifier from the invitation's `<A>` node goes in **WorkingDir**,
  **AlternateShell** is `*` because a shadow invitation has no password, and
  **Password** is `*`. The identifier is how the novice tells which invitation a
  connection is answering; without it the RDP connection completes normally and
  is then dropped.
- The account's own password is therefore never passed to this helper.
- The static `remdesk` channel is registered with the Remote Assistance v2
  control handshake. The expert speaks first: as soon as the session is active
  it sends `EXPERT_ON_VISTA` and `VERIFY_PASSWORD`, because the novice picks the
  protocol version from what it receives and `EXPERT_ON_VISTA` is what selects
  version 2 ([MS-RA] section 3). Waiting for the novice to announce itself
  leaves both sides silent until the listener drops the connection.
- `SERVER_ANNOUNCE`, `VERSIONINFO` and `RESULT` coming back are read for the
  trace; a `VERSIONINFO` naming a version other than `1.2` is reported, since
  that needs the `AUTHENTICATE` and `REMOTE_CONTROL_DESKTOP` exchange, which is
  not implemented.
- The channels the server grants are listed on connect. A channel reported as
  refused can never carry traffic, which is the first thing to rule out when the
  novice stays silent.
- `drdynvc` accepts the server-created `ECHO` channel, and `encomsp`, `70`,
  and `71` are registered for the Remote Assistance session.
- A direct TLS probe is retained for diagnostics with `--tls-probe`; it is not
  a valid Remote Assistance session path.

Build from the repository root:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
cargo build --manifest-path resources/remoteassistance-native/Cargo.toml
```

The control PDUs are covered by unit tests, which need no host:

```powershell
cargo test --manifest-path resources/remoteassistance-native/Cargo.toml
```

Examples:

```powershell
# Remote Assistance RDP/TLS path (default)
resources/remoteassistance-native/target/debug/terminaldeck-remoteassistance.exe 10.10.10.9 51878 USER --invitation-file invitation.xml

# Diagnostic only: direct TLS, without RDP/X.224
resources/remoteassistance-native/target/debug/terminaldeck-remoteassistance.exe 10.10.10.9 51878 USER --tls-probe
```

The unified `resources/shadowprobe/shadow-connect.cmd` wrapper requests a fresh
invitation, extracts the endpoint, qualifies the account name from the
invitation certificate, and starts this helper in one command.
