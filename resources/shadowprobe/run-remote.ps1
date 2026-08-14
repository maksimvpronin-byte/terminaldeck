<##
  Runs ShadowProbe on the target Windows host under explicit credentials.

  The native WinStation API authorises the caller on the machine where it runs;
  invoking it locally can never make a local user become a remote administrator.
  This copies only the standalone probe to a random temporary name, executes it
  through WinRM, prints its output, and removes the file in a finally block.
##>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $ComputerName,
  [uint32] $SessionId,
  [switch] $List,
  [switch] $Control,
  [switch] $PointerAbi,
  [switch] $UseSsl,
  [pscredential] $Credential
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SessionList.ps1')
$probe = Join-Path $PSScriptRoot 'SessEnvProbe.exe'
if (-not (Test-Path -LiteralPath $probe)) {
  throw "SessEnvProbe.exe is missing. Build it first with .\build-rpc-dev.cmd"
}

if (-not $Credential) {
  $Credential = Get-Credential -Message "Administrator credentials for $ComputerName"
}

$sessionOptions = New-PSSessionOption -ProxyAccessType NoProxyServer
$sessionArgs = @{
  ComputerName = $ComputerName
  Credential = $Credential
  SessionOption = $sessionOptions
}
if ($UseSsl) { $sessionArgs.UseSSL = $true }
$session = New-PSSession @sessionArgs
$remoteName = 'TerminalDeck-ShadowProbe-' + [guid]::NewGuid().ToString('N') + '.exe'
$remotePath = Join-Path 'C:\Windows\Temp' $remoteName
try {
  if ($List) {
    Get-ShadowSession -Session $session | Format-Table Id, Station, State, User, Shadowable -AutoSize
    return
  }
  if ($PSBoundParameters.ContainsKey('SessionId') -eq $false) {
    throw 'SessionId is required unless -List is specified'
  }
  Copy-Item -LiteralPath $probe -Destination $remotePath -ToSession $session
  $args = @('--call', [string]$SessionId)
  if ($Control) { $args += 'control' }
  if ($PointerAbi) { $args += 'pointer' }
  Invoke-Command -Session $session -ScriptBlock {
    param($path, $arguments)
    & $path @arguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } -ArgumentList $remotePath, $args
}
finally {
  try {
    Invoke-Command -Session $session -ScriptBlock {
      param($path)
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    } -ArgumentList $remotePath
  } catch { }
  Remove-PSSession $session
}
