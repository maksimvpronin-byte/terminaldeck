<# Generate the SessEnvPublicRpc client proxy with the Windows SDK MIDL compiler. #>
$ErrorActionPreference = 'Stop'
$midlCommand = Get-Command midl.exe -ErrorAction SilentlyContinue
$midlPath = if ($midlCommand) { $midlCommand.Source } else {
  $candidate = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter midl.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.DirectoryName -match '\\x64$' } | Select-Object -First 1
  if ($candidate) { $candidate.FullName }
}
if (-not $midlPath) {
  throw 'Windows SDK MIDL compiler not found. Install the Windows 10/11 SDK, then rerun build-rpc.cmd.'
}
$cl = Get-Command cl.exe -ErrorAction SilentlyContinue
if (-not $cl) {
  $cl = Get-ChildItem 'C:\Program Files\Microsoft Visual Studio' -Recurse -Filter cl.exe -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $cl) {
  throw 'MIDL was found, but cl.exe is missing. Install Visual Studio Build Tools with the Desktop C++ workload, then rerun build-rpc.cmd from a Developer PowerShell.'
}

$dir = $PSScriptRoot
& $midlPath /nologo /env x64 /out $dir (Join-Path $dir 'SessEnvPublicRpc.idl')
if ($LASTEXITCODE -ne 0) { throw "midl failed with $LASTEXITCODE" }

$clCommand = Get-Command cl.exe -ErrorAction SilentlyContinue
if (-not $clCommand) { throw 'cl.exe is not in PATH. Run build-rpc-dev.cmd or use a Developer PowerShell.' }
$output = Join-Path $dir 'SessEnvProbe.exe'
# /Fo keeps the object files beside the sources; without it cl writes them into
# whatever directory the build was started from, which is usually the repo root.
& $clCommand.Source /nologo /O2 /TC /DUNICODE /D_UNICODE `
  /Fe:$output /Fo:"$dir\" (Join-Path $dir 'SessEnvProbe.c') (Join-Path $dir 'SessEnvPublicRpc_c.c') `
  /link rpcrt4.lib oleaut32.lib
if ($LASTEXITCODE -ne 0) { throw "cl failed with $LASTEXITCODE" }
Write-Host "Generated and built SessEnvProbe.exe"
