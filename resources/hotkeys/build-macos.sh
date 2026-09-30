#!/usr/bin/env bash
#
# Builds td_hotkeys.node, the switch that lets ⌘Tab through to a full-screen
# desktop — see td_hotkeys.c for why it has to be native at all.
#
# One C file against Node-API, which is stable across Node and
# Electron alike, so the headers of whichever Node runs this will do and
# nothing is fetched: no node-gyp, no Electron headers, no network.
# `build:mac` runs it first.
#
#   npm run build:hotkeys
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "td_hotkeys is macOS only; nothing to build here."
  exit 0
fi

include="$(node -p "require('path').resolve(process.execPath, '..', '..', 'include', 'node')")"
if [ ! -f "$include/node_api.h" ]; then
  printf '\033[31merror: no Node-API headers at %s\033[0m\n' "$include" >&2
  exit 1
fi

arch="$(uname -m)"
mkdir -p "$here/build"
clang -std=c11 -O2 -Wall -Wextra -Werror \
  -arch "$arch" -mmacosx-version-min=11.0 \
  -bundle -undefined dynamic_lookup \
  -framework Carbon -framework CoreFoundation \
  -I"$include" \
  -o "$here/build/td_hotkeys.node" "$here/td_hotkeys.c"

echo "Built $here/build/td_hotkeys.node ($arch)"
