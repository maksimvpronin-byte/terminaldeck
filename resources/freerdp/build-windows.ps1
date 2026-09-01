<#
Builds FreeRDP and td-rdp for Windows, into resources\freerdp\build\windows-<arch>.

The same shape as build-macos.sh, and the same reasoning: a pinned version, so a
regression later can be told apart from a version change; every option stated
rather than discovered, because CMake enables what it finds and what it finds
depends on whose machine it is; and the whole output kept, because the
interesting line in a build this size is never the last one.

Where it differs from macOS is where Windows does. There is no Homebrew, so the
libraries come from vcpkg — OpenSSL, openh264 for H.264, opus for sound, zlib.
And there is no rpath: a Windows program finds its DLLs beside itself, so the
last step copies them there instead of rewriting install names.

    npm run build:freerdp:win        the lot, an hour the first time
    npm run build:freerdp:win:shim   only td-rdp, seconds

Requires: Visual Studio 2022 with the C++ workload, CMake, Ninja, Git. Set
VCPKG_ROOT to an existing vcpkg, or one is fetched into resources\freerdp\vcpkg.
#>
[CmdletBinding()]
param(
  # Rebuild only td-rdp against a FreeRDP that is already built. Changing a line
  # of C should not rebuild four hundred and sixty targets to find out whether
  # it compiles.
  [switch]$ShimOnly
)

$ErrorActionPreference = 'Stop'

$FreeRdpTag = if ($env:FREERDP_TAG) { $env:FREERDP_TAG } else { '3.31.0' }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$triplet = "$arch-windows"
$src = Join-Path $here "src\FreeRDP-$FreeRdpTag"
$out = Join-Path $here "build\windows-$arch"
$log = Join-Path $here "build\build-windows-$arch.log"

function Say([string]$text) { Write-Host "`n==> $text" -ForegroundColor White }
function Die([string]$text) { Write-Host "`nerror: $text" -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force -Path (Join-Path $here 'build') | Out-Null
Start-Transcript -Path $log -Force | Out-Null

# Whatever happens, say what went wrong before the window scrolls away.
trap {
  Write-Host "`nFailed. What went wrong:" -ForegroundColor Red
  if (Test-Path $log) {
    Select-String -Path $log -Pattern 'error|fatal|CMake Error' -CaseSensitive:$false |
      Select-Object -First 30 | ForEach-Object { Write-Host $_.Line }
  }
  Stop-Transcript | Out-Null
  exit 1
}

# ------------------------------------------------------------- prerequisites
#
# Checked together and up front: a build that dies twenty minutes in for a
# missing tool wastes twenty minutes.
Say 'Checking what is needed'
$missing = @()
foreach ($tool in 'cmake', 'ninja', 'git') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { $missing += $tool }
}
if ($missing) { Die "missing: $($missing -join ', ') — install them, or add them to PATH" }

# The compiler comes from Visual Studio, and only inside its environment: cl.exe
# needs a dozen variables set that the installer does not put in PATH. vswhere
# ships with every install since 2017 and is the supported way to find it.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { Die 'Visual Studio is not installed, or is older than 2017' }
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { Die 'Visual Studio is installed without the C++ workload' }

# --------------------------------------------------------------------- vcpkg
$vcpkg = if ($env:VCPKG_ROOT) { $env:VCPKG_ROOT } else { Join-Path $here 'vcpkg' }
if (-not (Test-Path (Join-Path $vcpkg 'vcpkg.exe'))) {
  Say "Fetching vcpkg into $vcpkg"
  if (-not (Test-Path $vcpkg)) {
    git clone --depth 1 https://github.com/microsoft/vcpkg.git $vcpkg
  }
  & (Join-Path $vcpkg 'bootstrap-vcpkg.bat') -disableMetrics
  if ($LASTEXITCODE -ne 0) { Die 'vcpkg would not bootstrap' }
}

# The same four libraries the macOS build takes from Homebrew, and for the same
# reasons: openh264 is most of the point of moving to FreeRDP at all, and opus
# is sound. Named explicitly so a machine that happens to have more installed
# does not produce a different binary.
Say "Installing dependencies for $triplet"
& (Join-Path $vcpkg 'vcpkg.exe') install --triplet $triplet openssl openh264 opus zlib
if ($LASTEXITCODE -ne 0) { Die 'vcpkg could not install the dependencies' }

# ----------------------------------------------------------------- the source
Say "Fetching FreeRDP $FreeRdpTag"
New-Item -ItemType Directory -Force -Path (Join-Path $here 'src') | Out-Null
if (-not (Test-Path $src)) {
  # A shallow clone of the tag rather than a tarball: no checksum to keep in
  # step with, and the tag is what the version means.
  git clone --depth 1 --branch $FreeRdpTag https://github.com/FreeRDP/FreeRDP.git $src
} else {
  Write-Host "already at $src"
}

# ------------------------------------------------------------------ the build
$toolchain = Join-Path $vcpkg 'scripts\buildsystems\vcpkg.cmake'

if (-not $ShimOnly) {
  Say 'Configuring FreeRDP'
  Remove-Item -Recurse -Force (Join-Path $src 'build') -ErrorAction SilentlyContinue

  # Every flag here means what the same flag means in build-macos.sh; read that
  # file for why each one is stated rather than left to be discovered. The SDL
  # client is the one deliberate difference: on macOS it is what proves the
  # build by hand, and here it would drag SDL2, SDL2_ttf and SDL2_image through
  # vcpkg for a program that is never shipped.
  cmake -S $src -B (Join-Path $src 'build') -G Ninja `
    -DCMAKE_BUILD_TYPE=Release `
    -DCMAKE_TOOLCHAIN_FILE="$toolchain" `
    -DVCPKG_TARGET_TRIPLET="$triplet" `
    -DCMAKE_INSTALL_PREFIX="$out" `
    -DWITH_VERBOSE_WINPR_ASSERT=OFF `
    -DBUILD_TESTING=OFF `
    -DWITH_OPENH264=ON `
    -DWITH_FFMPEG=OFF `
    -DWITH_SWSCALE=OFF `
    -DWITH_OPUS=ON `
    -DWITH_PCSC=OFF `
    -DWITH_CUPS=OFF `
    -DCHANNEL_URBDRC=OFF `
    -DWITH_SERVER=OFF `
    -DWITH_SHADOW=OFF `
    -DWITH_PROXY=OFF `
    -DWITH_SAMPLE=OFF `
    -DWITH_CLIENT_SDL=OFF `
    -DWITH_MANPAGES=OFF
  if ($LASTEXITCODE -ne 0) { Die 'CMake would not configure FreeRDP' }

  Say 'Building FreeRDP'
  cmake --build (Join-Path $src 'build') --parallel
  if ($LASTEXITCODE -ne 0) { Die 'FreeRDP would not build' }

  Say "Installing into $out"
  Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
  cmake --install (Join-Path $src 'build')
  if ($LASTEXITCODE -ne 0) { Die 'FreeRDP would not install' }
}

# ------------------------------------------------------------------- the shim
if (-not (Test-Path (Join-Path $out 'lib\cmake\FreeRDP3'))) {
  Die "no FreeRDP at $out — run this without -ShimOnly first"
}

Say 'Building td-rdp'
$shim = Join-Path $here 'shim'
Remove-Item -Recurse -Force (Join-Path $shim 'build') -ErrorAction SilentlyContinue
cmake -S $shim -B (Join-Path $shim 'build') -G Ninja `
  -DCMAKE_BUILD_TYPE=Release `
  -DCMAKE_TOOLCHAIN_FILE="$toolchain" `
  -DVCPKG_TARGET_TRIPLET="$triplet" `
  -DCMAKE_PREFIX_PATH="$out" `
  -DCMAKE_INSTALL_PREFIX="$out"
if ($LASTEXITCODE -ne 0) { Die 'CMake would not configure td-rdp' }

cmake --build (Join-Path $shim 'build') --parallel
if ($LASTEXITCODE -ne 0) { Die 'td-rdp would not build' }
cmake --install (Join-Path $shim 'build')

# ------------------------------------------------------------------ the result
Say 'What came out'
Get-ChildItem (Join-Path $out 'bin') | Format-Table Name, Length -AutoSize

Write-Host @"

Built FreeRDP $FreeRdpTag and td-rdp into $out
The whole build log is in $log

Nothing here is run by hand: td-rdp reads its instructions from a pipe and
writes back pixels, so a terminal gets nothing out of it. The application
starts it; see src\main\rdp\FreeRdpBridge.ts.

Before packaging, run bundle-windows.ps1 — it puts the DLLs beside the
executable, which is where Windows looks for them.
"@

Stop-Transcript | Out-Null
