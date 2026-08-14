<# Builds the standalone RpcShadow2 probe. It is intentionally not packaged. #>
$ErrorActionPreference = 'Stop'

$dir = $PSScriptRoot
$source = Join-Path $dir 'ShadowProbe.cs'
$output = Join-Path $dir 'ShadowProbe.exe'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $csc)) { throw "No C# compiler at $csc" }
& $csc /nologo /target:exe /optimize+ /out:$output $source
if ($LASTEXITCODE -ne 0) { throw "csc failed with $LASTEXITCODE" }
Write-Host ("built ShadowProbe.exe, {0} bytes" -f (Get-Item $output).Length)
