<##
  Requests a shadow invitation and connects the native Remote Assistance client
  to it.

  The shadow session belongs to the process that asked for it. A probe that
  prints its invitation and exits leaves a listener that still accepts a
  connection and completes an RDP handshake before dropping it, so the probe is
  started as a job and held open while the expert connects.
##>
[CmdletBinding()]
param(
  [string] $ComputerName = '10.10.10.9',
  # No default: a session number that is merely plausible is worse than none,
  # because shadowing the wrong one still produces an invitation, to nothing.
  [uint32] $SessionId,
  [string] $NativeClient,
  [pscredential] $Credential,
  [uint32] $HoldSeconds = 180
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SessionList.ps1')

if ([string]::IsNullOrWhiteSpace($NativeClient)) {
  $NativeClient = Join-Path $PSScriptRoot '..\remoteassistance-native\target\debug\terminaldeck-remoteassistance.exe'
}

if (-not (Test-Path -LiteralPath $NativeClient)) {
  throw "Native Remote Assistance client not found: $NativeClient"
}

$probe = Join-Path $PSScriptRoot 'SessEnvProbe.exe'
if (-not (Test-Path -LiteralPath $probe)) {
  throw "SessEnvProbe.exe is missing. Build it first with .\build-rpc-dev.cmd"
}

if (-not $Credential) {
  $Credential = Get-Credential -Message "Administrator credentials for $ComputerName"
}

# WinRM otherwise inherits the machine's HTTP proxy and refuses the connection.
$session = New-PSSession `
  -ComputerName $ComputerName `
  -Credential $Credential `
  -SessionOption (New-PSSessionOption -ProxyAccessType NoProxyServer)

$remotePath = Join-Path 'C:\Windows\Temp' `
  ('TerminalDeck-ShadowProbe-' + [guid]::NewGuid().ToString('N') + '.exe')
$job = $null
$invitationFile = $null
$exitCode = 1

try {
  # Check the target before asking for anything. RpcShadow2 answers for a
  # session nobody is using: it returns a listener with no session behind it,
  # which accepts a connection, completes the RDP handshake and then drops it.
  $sessions = Get-ShadowSession -Session $session
  $shadowable = @($sessions | Where-Object Shadowable)

  # An unshadowable target is an ordinary answer, not a failure of this script,
  # so it says so and stops. Throwing would repeat the text in an error record
  # and bury a plain sentence under a stack trace.
  $explain = {
    param($reason)
    Write-Host $reason
    $sessions | Format-Table Id, Station, State, User -AutoSize | Out-Host
    exit 2
  }

  if ($PSBoundParameters.ContainsKey('SessionId')) {
    $target = $sessions | Where-Object { $_.Id -eq $SessionId }
    if (-not $target) {
      & $explain "$ComputerName has no session $SessionId."
    }
    if (-not $target.Shadowable) {
      & $explain ("Session $SessionId on $ComputerName is $($target.State) and cannot be shadowed. " +
        'Only an Active session with a signed-in user can be.')
    }
  }
  elseif ($shadowable.Count -eq 0) {
    & $explain "$ComputerName has no session that can be shadowed. Sign in to it over RDP first."
  }
  elseif ($shadowable.Count -gt 1) {
    & $explain "$ComputerName has more than one session that can be shadowed; name one with -SessionId."
  }
  else {
    $SessionId = $shadowable[0].Id
    Write-Host "Shadowing session $SessionId, signed in as $($shadowable[0].User)."
  }

  Copy-Item -LiteralPath $probe -Destination $remotePath -ToSession $session

  Write-Host "Requesting a shadow invitation for session $SessionId on $ComputerName, held open for $HoldSeconds seconds..."
  $job = Invoke-Command -Session $session -AsJob -ScriptBlock {
    param($path, $sid, $hold)
    & $path '--call' $sid '--hold' $hold
  } -ArgumentList $remotePath, ([string]$SessionId), ([string]$HoldSeconds)

  # The probe flushes the invitation before it starts holding, so this reads the
  # job's output as it arrives rather than waiting for the process to end.
  $probeOutput = ''
  # Asking for permission makes RpcShadow2 block until the far side answers, so
  # this waits long enough for a person to reach the prompt.
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    $probeOutput += (Receive-Job -Job $job | Out-String)
    if ($probeOutput -match '(?s)<E>.*?</E>') { break }
    if ($job.State -in @('Completed', 'Failed', 'Stopped')) { break }
    Start-Sleep -Milliseconds 300
  }

  # RpcShadow2 answers with what the host's policy made of the request, and an
  # invitation can come back alongside a refusal. Say so rather than dropping it.
  foreach ($line in ($probeOutput -split "`r?`n" | Where-Object { $_ -match '^HRESULT=' })) {
    Write-Host "Probe: $line"
  }

  $invitationMatch = [regex]::Match(
    $probeOutput, '<E>.*?</E>',
    [System.Text.RegularExpressions.RegexOptions]::Singleline
  )
  if (-not $invitationMatch.Success) {
    if ($probeOutput.Trim()) { Write-Error $probeOutput.Trim() }
    throw "No Remote Assistance invitation arrived; the probe job is $($job.State)."
  }

  $portMatch = [regex]::Match(
    $invitationMatch.Value,
    '<L\s+P="(?<port>\d+)"\s+N="(?<host>\d{1,3}(?:\.\d{1,3}){3})"'
  )
  if (-not $portMatch.Success) {
    throw 'The invitation names no IPv4 Remote Assistance listener.'
  }

  $invitationFile = Join-Path ([IO.Path]::GetTempPath()) `
    ('terminaldeck-shadow-' + [guid]::NewGuid().ToString('N') + '.xml')
  $invitationMatch.Value | Set-Content -LiteralPath $invitationFile -Encoding UTF8 -NoNewline

  $port = [int]$portMatch.Groups['port'].Value
  $hostAddress = $portMatch.Groups['host'].Value
  # The account password is not handed to the native client. Remote Assistance
  # requires "*" in the Client Info PDU password field, so the real one would
  # only sit in the process list unused.
  $nativeUser = $Credential.UserName

  # The name is passed unqualified. It was once machine-qualified on the belief
  # that mstsc puts the full account name into the X.224 mstshash cookie; a
  # capture of a working shadow session shows mstsc sends no cookie at all. All
  # the name reaches is the UserName field of the Client Info PDU, which [MS-RA]
  # section 2.2.7.2 describes as the expert's name.
  $nativeUser = ($nativeUser -split '\\')[-1]

  Write-Host "Connecting to $hostAddress`:$port as $nativeUser while the shadow session is held open..."
  & $NativeClient $hostAddress $port $nativeUser '--invitation-file' $invitationFile
  $exitCode = $LASTEXITCODE
}
finally {
  if ($invitationFile) { Remove-Item -LiteralPath $invitationFile -Force -ErrorAction SilentlyContinue }
  if ($job) {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
  try {
    # Stopping the job ends the remote pipeline but need not end the process it
    # started, so the probe is stopped by name before its file is removed.
    Invoke-Command -Session $session -ScriptBlock {
      param($path)
      Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($path)) -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    } -ArgumentList $remotePath -ErrorAction SilentlyContinue
  } catch { }
  Remove-PSSession $session -ErrorAction SilentlyContinue
}

exit $exitCode
