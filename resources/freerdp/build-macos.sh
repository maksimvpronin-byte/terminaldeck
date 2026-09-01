#!/usr/bin/env bash
#
# Builds FreeRDP for macOS, into resources/freerdp/build/macos-<arch>.
#
# Why a build of our own rather than Homebrew's: the Homebrew binary announces
# `WITH_VERBOSE_WINPR_ASSERT=ON` and says of itself that runtime checks "might
# slow down the application", and it links against dylibs at paths that exist on
# the machine that built it. Neither is shippable. This produces a Release build
# with the checks off.
#
# It also builds the SDL client, which is not needed to ship but is what makes
# the build verifiable: run it against a real host and the whole chain — codecs,
# gateway, TLS — is proven before a line of integration is written.
#
# Run it yourself; it is not run from any npm script that CI touches yet.
set -euo pipefail

# Pinned deliberately. 3.31.0 is the version the comparison against IronRDP was
# made with, so a regression later can be told apart from a version change.
FREERDP_TAG="${FREERDP_TAG:-3.31.0}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Named as Node and electron-builder name it, not as uname does: this path is
# looked up by the application at runtime and by the packager at build time,
# and a third spelling in the middle is one translation too many.
arch="$(uname -m)"
[ "$arch" = "x86_64" ] && arch="x64"
src="$here/src/FreeRDP-$FREERDP_TAG"
out="$here/build/macos-$arch"

log="$here/build/build-macos-$arch.log"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

# Everything from here on is kept, because a compiler error in a build of this
# size scrolls past long before anyone can read it — and the interesting line is
# never the last one.
mkdir -p "$here/build"
exec > >(tee "$log") 2>&1
trap 'code=$?; [ $code -ne 0 ] && printf "\n\033[31mFailed. What went wrong:\033[0m\n" && grep -niE "error:|CMake Error|fatal error|No such file" "$log" | head -20; exit $code' EXIT

# ---------------------------------------------------------------- prerequisites
#
# Checked up front and all at once: a build that dies twenty minutes in for a
# missing tool wastes twenty minutes.
say "Checking what is needed"
missing=()
for tool in cmake ninja pkg-config git; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ ${#missing[@]} -gt 0 ]; then
  die "missing: ${missing[*]} — brew install ${missing[*]}"
fi

# openssl and openh264 are the two that matter. Without openh264 there is no
# H.264 decoder, which is most of the point of moving to FreeRDP at all; the
# build would succeed and the sessions would quietly fall back.
# opus is the audio codec: sound redirection is wanted, so it is required here
# rather than picked up if it happens to be around.
# sdl2_ttf and sdl2_image are for the SDL client's own dialogs, not for RDP —
# they are here only because that client is what makes the build verifiable.
# Turn WITH_CLIENT_SDL off below and they stop being needed.
# The SDL client is what makes a build verifiable by hand, and is never shipped.
# `FREERDP_SDL=0` leaves it out, which is what CI wants: three Homebrew packages
# and a few minutes of compiling, for a program no release contains.
sdl_client="${FREERDP_SDL:-1}"
libs="openssl@3 openh264 opus"
[ "$sdl_client" = "1" ] && libs="$libs sdl2 sdl2_ttf sdl2_image"
for lib in $libs; do
  brew --prefix "$lib" >/dev/null 2>&1 || die "missing: $lib — brew install $lib"
done

export PKG_CONFIG_PATH="$(brew --prefix openssl@3)/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
export OPENSSL_ROOT_DIR="$(brew --prefix openssl@3)"

# One directory, and the build dies at libfreerdp/codec/dsp.c without it.
#
# opus.pc publishes `-I<prefix>/include/opus`, so that code can write
# `#include <opus.h>`. FreeRDP's dsp.c writes `#include <opus/opus.h>`, which
# needs the parent. On Linux the parent is /usr/include and is already on the
# default search path, so upstream never sees this; under Homebrew nothing is on
# the default path and the header is simply not found.
opus_include="$(brew --prefix opus)/include"

# ------------------------------------------------------------------- the source
say "Fetching FreeRDP $FREERDP_TAG"
mkdir -p "$here/src"
if [ ! -d "$src" ]; then
  # A shallow clone of the tag rather than a tarball: no checksum to keep in
  # step with, and the tag is what the version means.
  git clone --depth 1 --branch "$FREERDP_TAG" \
    https://github.com/FreeRDP/FreeRDP.git "$src"
else
  echo "already at $src"
fi

# -------------------------------------------------------------------- the build
say "Configuring"
rm -rf "$src/build"
cmake -S "$src" -B "$src/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$out" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
  \
  `# The checks Homebrew leaves on, which is why its build is slower.` \
  -DWITH_VERBOSE_WINPR_ASSERT=OFF \
  -DBUILD_TESTING=OFF \
  \
  `# H.264, without which the move to FreeRDP buys much less than it should.` \
  -DWITH_OPENH264=ON \
  \
  `# And explicitly not ffmpeg, which CMake picks up on its own if it is` \
  `# installed. The first build here did, and dragged in libavcodec,` \
  `# libavformat, libavfilter, swscale and three more — a hundred megabytes` \
  `# for a decoder openh264 already provides, and a licence problem besides:` \
  `# Homebrew builds ffmpeg with GPL components, and linking against those` \
  `# would make this application GPL.` \
  -DWITH_FFMPEG=OFF \
  -DWITH_SWSCALE=OFF \
  \
  `# Sound is wanted, so Opus is asked for by name and given the include path` \
  `# its own pkg-config file does not provide. CoreAudio is found on its own.` \
  -DWITH_OPUS=ON \
  -DCMAKE_C_FLAGS="-I$opus_include" \
  \
  `# And the same lesson ffmpeg taught, applied ahead of time: FreeRDP enables` \
  `# what it finds, and what it finds depends on whose machine it is. Smart` \
  `# cards, printers and USB are not redirected by this application; each is a` \
  `# dependency to build and ship for three platforms, and each is one line` \
  `# away if that changes. An option that a later version drops is a harmless` \
  `# unused-variable warning; a dependency that appears because someone had it` \
  `# installed is not.` \
  -DWITH_PCSC=OFF \
  -DWITH_CUPS=OFF \
  -DCHANNEL_URBDRC=OFF \
  \
  `# A client, and nothing that serves: no shadow server, no proxy, no samples.` \
  -DWITH_SERVER=OFF \
  -DWITH_SHADOW=OFF \
  -DWITH_PROXY=OFF \
  -DWITH_SAMPLE=OFF \
  \
  `# The SDL client is the thing that proves the build works end to end, and` \
  `# the one thing here a release never contains — see FREERDP_SDL above.` \
  -DWITH_CLIENT_SDL=$([ "$sdl_client" = "1" ] && echo ON || echo OFF) \
  \
  `# Needs xsltproc otherwise, and nothing here reads a man page.` \
  -DWITH_MANPAGES=OFF

say "Building"
cmake --build "$src/build" --parallel

say "Installing into $out"
rm -rf "$out"
cmake --install "$src/build"

# --------------------------------------------------------------------- the shim
#
# Built here rather than by hand, and into the same prefix, because the two
# belong together: td-rdp is compiled against these headers and links these
# libraries, and a shim built against one FreeRDP and shipped beside another is
# a crash nobody would find quickly.
say "Building the shim"
rm -rf "$here/shim/build"
FREERDP_PREFIX="$out" bash "$here/build-shim.sh"

# ------------------------------------------------------------------- the result
say "What came out"
find "$out" -maxdepth 2 -type d -name bin -o -maxdepth 2 -type d -name lib | sort
echo
ls -la "$out/bin" 2>/dev/null || echo "(no bin/ — check the configure output above)"

cat <<EOF

Built FreeRDP $FREERDP_TAG into $out
The whole build log is in $log

What TerminalDeck actually uses is $out/bin/td-rdp. It is not run by hand: it
reads its instructions from a pipe and writes back pixels, so a terminal gets
nothing out of it. The application starts it; see src/main/rdp/FreeRdpBridge.ts.

The SDL client beside it is for proving the build, and is worth a run whenever
something is wrong and it is not clear which side is at fault:

  $out/bin/sdl2-freerdp /v:HOST /u:'USER@DOMAIN' /gateway:g:GATEWAY /size:2560x1440

What this build is NOT yet is shippable. Every library it links points at
/opt/homebrew/opt/..., which exists only on the machine that built it. Making
it portable — static linking, or bundling the dylibs and rewriting their paths
to @loader_path — is the next piece of work, and it is worth doing only once
this build has been proven against a real host.
EOF
