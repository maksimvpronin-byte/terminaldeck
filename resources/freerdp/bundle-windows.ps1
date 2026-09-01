<#
Puts the DLLs beside td-rdp.exe, which is where Windows looks for them.

The counterpart of bundle-macos.sh, and much shorter, because Windows solves
this problem by looking in the executable's own directory. There is no rpath to
rewrite and no signature to repair — only files to copy.

What has to travel: FreeRDP's own three, which CMake already installs into bin\,
and the four vcpkg provides — OpenSSL, openh264, opus, zlib — which it does not,
because a Ninja build has none of the app-local deployment a Visual Studio
project would get.

Run by `npm run build:win` before packaging, and safe to run again: it copies
what is missing and says what it found.
#>
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$triplet = "$arch-windows"
$out = if ($env:FREERDP_PREFIX) { $env:FREERDP_PREFIX } else { Join-Path $here "build\windows-$arch" }
$bin = Join-Path $out 'bin'

function Step([string]$text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Die([string]$text) { Write-Host "`nerror: $text" -ForegroundColor Red; exit 1 }

# Built rather than refused, so packaging is one command from a fresh clone.
# Said out loud first: somebody who expected two minutes should know why it is
# going to be thirty, and that it happens once.
if (-not (Test-Path (Join-Path $bin 'td-rdp.exe'))) {
  Step 'No desktop client yet — building FreeRDP first'
  Write-Host @'
This takes about half an hour and happens once: what it produces stays in
resources\freerdp\build\ and later packaging runs reuse it. Changing the shim's
own C afterwards is `npm run build:freerdp:win:shim`, which takes seconds.
'@
  & npm run build:freerdp:win
  if ($LASTEXITCODE -ne 0) { Die 'the desktop client did not build — see the log above' }
}

if (-not (Test-Path (Join-Path $bin 'td-rdp.exe'))) {
  Die "still no td-rdp.exe at $bin — see the log above"
}

$vcpkg = if ($env:VCPKG_ROOT) { $env:VCPKG_ROOT } else { Join-Path $here 'vcpkg' }
$from = Join-Path $vcpkg "installed\$triplet\bin"
if (-not (Test-Path $from)) { Die "no vcpkg libraries at $from — run: npm run build:freerdp:win" }

# ------------------------------------------- the Visual C++ runtime
#
# The one thing a portable build cannot assume is there.
#
# td-rdp.exe and every library vcpkg produced are linked against the dynamic
# Visual C++ runtime, which is not part of Windows: it arrives with Visual
# Studio, or with the redistributable somebody installed. A machine that has
# neither — which is exactly the machine a portable build is carried to — starts
# the application fine and cannot start the desktop client at all.
#
# Copied from the redistributable directory inside the Visual Studio install,
# which is the arrangement Microsoft licenses for exactly this. Not from
# System32: those belong to the machine that is building, and their version is
# whatever that machine happens to have.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path $vswhere) {
  $vs = & $vswhere -latest -products * -property installationPath
  $redist = Join-Path $vs "VC\Redist\MSVC"
  if ($vs -and (Test-Path $redist)) {
    $crt = Get-ChildItem $redist -Directory |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "$arch\Microsoft.VC143.CRT" } |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
    if ($crt) {
      Step "Copying the Visual C++ runtime from $crt"
      Copy-Item (Join-Path $crt '*.dll') -Destination $bin -Force
    } else {
      Write-Host "warning: no VC++ runtime found under $redist — a machine without the redistributable will not run the desktop client" -ForegroundColor Yellow
    }
  }
}

Step "Copying the dependencies into $bin"
# All of them rather than the four by name: openssl brings its own pair, and the
# set changes with the version. They are small, and a list that is right today
# is a list that is wrong the next time vcpkg splits a package.
Copy-Item (Join-Path $from '*.dll') -Destination $bin -Force

Step 'What will be shipped'
Get-ChildItem (Join-Path $bin '*.exe'), (Join-Path $bin '*.dll') | Format-Table Name, Length -AutoSize
