#!/usr/bin/env bash
#
# Builds td-rdp against a FreeRDP that is already installed.
#
# Split out from build-<platform>.sh so that changing a line of C does not
# rebuild four hundred and sixty targets of FreeRDP to find out whether it
# compiles. The platform script calls this at the end; anyone working on the
# shim calls it directly, which takes seconds.
#
#   npm run build:freerdp:shim
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

arch="$(uname -m)"
[ "$arch" = "x86_64" ] && arch="x64"
case "$(uname -s)" in
  Darwin) prefix="$here/build/macos-$arch" ;;
  Linux) prefix="$here/build/linux-$arch" ;;
  *) prefix="$here/build/$(uname -s)-$arch" ;;
esac
prefix="${FREERDP_PREFIX:-$prefix}"

log="$here/build/build-shim.log"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [ ! -d "$prefix/lib/cmake/FreeRDP3" ]; then
  printf '\033[31merror: no FreeRDP at %s — run the platform build first\033[0m\n' "$prefix" >&2
  exit 1
fi

mkdir -p "$here/build"
exec > >(tee "$log") 2>&1
trap 'code=$?; [ $code -ne 0 ] && printf "\n\033[31mFailed. What went wrong:\033[0m\n" && grep -niE "error:|CMake Error|fatal error|No such file" "$log" | head -30; exit $code' EXIT

say "Building td-rdp against $prefix"
extra=()
[ "$(uname -s)" = "Darwin" ] && extra+=(-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0)

cmake -S "$here/shim" -B "$here/shim/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH="$prefix" \
  -DCMAKE_INSTALL_PREFIX="$prefix" \
  "${extra[@]}"
cmake --build "$here/shim/build" --parallel
cmake --install "$here/shim/build"

say "Built $prefix/bin/td-rdp"
ls -la "$prefix/bin/td-rdp"
