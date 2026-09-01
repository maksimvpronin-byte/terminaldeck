<#
  Builds ShadowHost.exe.

  Uses the C# compiler that ships with the .NET Framework, present on every
  Windows since 4.0 — so this needs no SDK installed, on a workstation or on a
  build runner. That is the whole reason the host is C# rather than C++ or Rust:
  those would each mean a toolchain to install before the app could be packaged.
#>
$ErrorActionPreference = 'Stop'

$dir = $PSScriptRoot
$source = Join-Path $dir 'ShadowHost.cs'
$output = Join-Path $dir 'ShadowHost.exe'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $csc)) { throw "No C# compiler at $csc" }

# Skip the work when nothing changed: this runs before every Windows package.
if ((Test-Path $output) -and (Get-Item $output).LastWriteTimeUtc -gt (Get-Item $source).LastWriteTimeUtc) {
  Write-Host "ShadowHost.exe is up to date"
  exit 0
}

& $csc /nologo /target:winexe /optimize+ /out:$output `
  /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll `
  $source

if ($LASTEXITCODE -ne 0) { throw "csc failed with $LASTEXITCODE" }
Write-Host ("built ShadowHost.exe, {0} bytes" -f (Get-Item $output).Length)
