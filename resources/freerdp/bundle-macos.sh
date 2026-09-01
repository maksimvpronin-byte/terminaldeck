#!/usr/bin/env bash
#
# Makes the macOS build portable, so it runs on a machine that has never heard
# of Homebrew.
#
# What comes out of build-macos.sh links against /opt/homebrew/opt/... — paths
# that exist only on the machine that built it. This copies every library it
# actually needs into lib/ beside it, rewrites each reference to @rpath, and
# re-signs what it touched.
#
# The signing is not optional and not an afterthought: on Apple Silicon a Mach-O
# file whose signature does not match its contents is refused by the kernel, and
# install_name_tool changes the contents of every file it rewrites. Skipping
# this produces a build that runs on the machine that made it — where the
# original signature is still cached — and is killed on arrival anywhere else.
#
#   npm run build:freerdp:bundle
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
arch="$(uname -m)"
[ "$arch" = "x86_64" ] && arch="x64"
prefix="${FREERDP_PREFIX:-$here/build/macos-$arch}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$prefix/lib" ] || die "no build at $prefix — run npm run build:freerdp:mac first"

# Anything under these is the operating system's and is present everywhere.
is_system() { case "$1" in /usr/lib/*|/System/*) return 0 ;; *) return 1 ;; esac; }

# What a Mach-O file depends on, one path per line.
deps() { otool -L "$1" | tail -n +2 | awk '{print $1}'; }

say "Collecting what the build actually needs"

# Walked rather than listed: FreeRDP pulls in openssl, which pulls in nothing,
# and openh264 and opus which pull in libc++ — and the set changes with the
# build flags. A hand-written list would be right until the day it was not.
pending=()
for file in "$prefix"/bin/* "$prefix"/lib/*.dylib; do
  [ -f "$file" ] || continue
  pending+=("$file")
done

copied=()
while [ ${#pending[@]} -gt 0 ]; do
  file="${pending[0]}"
  pending=("${pending[@]:1}")

  while read -r dep; do
    [ -n "$dep" ] || continue
    is_system "$dep" && continue
    # Already ours: @rpath, @loader_path and @executable_path all resolve
    # inside the bundle and need no copy.
    case "$dep" in @*) continue ;; esac

    name="$(basename "$dep")"
    if [ ! -f "$prefix/lib/$name" ]; then
      echo "  + $name"
      cp -f "$dep" "$prefix/lib/$name"
      chmod u+w "$prefix/lib/$name"
      copied+=("$prefix/lib/$name")
      # Its own dependencies come along too.
      pending+=("$prefix/lib/$name")
    fi
  done < <(deps "$file")
done

say "Rewriting the paths"

for file in "$prefix"/bin/* "$prefix"/lib/*.dylib; do
  [ -f "$file" ] || continue

  # A library states its own name, and everything that links it records that
  # name. Both have to become @rpath or the loader goes looking in /opt again.
  case "$file" in
    *.dylib) install_name_tool -id "@rpath/$(basename "$file")" "$file" 2>/dev/null || true ;;
  esac

  while read -r dep; do
    [ -n "$dep" ] || continue
    is_system "$dep" && continue
    case "$dep" in @*) continue ;; esac
    install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$file" 2>/dev/null || true
  done < <(deps "$file")
done

# Where @rpath points. A binary looks beside itself and one level up; a library
# looks in its own directory, which is where everything now lives.
for file in "$prefix"/bin/*; do
  [ -f "$file" ] || continue
  install_name_tool -add_rpath "@executable_path/../lib" "$file" 2>/dev/null || true
done
for file in "$prefix"/lib/*.dylib; do
  [ -f "$file" ] || continue
  install_name_tool -add_rpath "@loader_path" "$file" 2>/dev/null || true
done

say "Signing what was rewritten"
# Ad-hoc, which is all that is needed for the file to load. electron-builder
# signs the application properly afterwards, with a real identity if one is
# configured; what matters here is that nothing is left with a signature that
# contradicts its own bytes.
for file in "$prefix"/bin/* "$prefix"/lib/*.dylib; do
  [ -f "$file" ] || continue
  codesign --force --sign - "$file" >/dev/null 2>&1 || true
done

say "Checking that nothing still points at this machine"
left=0
for file in "$prefix"/bin/* "$prefix"/lib/*.dylib; do
  [ -f "$file" ] || continue
  while read -r dep; do
    case "$dep" in
      /opt/*|/usr/local/*|"$prefix"*)
        printf '  %s -> %s\n' "$(basename "$file")" "$dep"
        left=1
        ;;
    esac
  done < <(deps "$file")
done

[ "$left" -eq 0 ] || die "some references were not rewritten; see above"

printf '\nPortable. %s libraries, %s\n' \
  "$(ls "$prefix"/lib/*.dylib | wc -l | tr -d ' ')" \
  "$(du -sh "$prefix" | cut -f1)"
echo "This is what electron-builder ships as Resources/freerdp."
