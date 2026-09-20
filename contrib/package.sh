#!/usr/bin/env bash
# Build the Chrome Web Store upload: a zip whose contents are exactly extension/.
#
#   contrib/package.sh            -> dist/ghost-browser-relay-<version>.zip
#   contrib/package.sh out/       -> out/ghost-browser-relay-<version>.zip
#
# There is no build step and there never will be one — the store's "no remote
# code" rule is easiest to hold when the thing reviewed and the thing that runs
# are the same bytes. So packaging is only zipping, with two properties worth
# being strict about:
#
#   * the zip is rooted at extension/, so manifest.json is at the top level and
#     nothing outside that directory can ride along;
#   * entries are sorted and timestamps are dropped, so the same tree produces
#     the same archive and a reviewer's diff between versions is the real diff.
set -euo pipefail

PACKAGE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$PACKAGE_DIR/extension"
OUT_DIR="${1:-$PACKAGE_DIR/dist}"

command -v zip >/dev/null 2>&1 || { echo "package.sh: zip is not installed" >&2; exit 1; }

VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SOURCE_DIR/manifest.json" | head -n 1)"
[ -n "$VERSION" ] || { echo "package.sh: no version in extension/manifest.json" >&2; exit 1; }

mkdir -p -- "$OUT_DIR"
OUT_DIR="$(cd -- "$OUT_DIR" && pwd)"
ZIP="$OUT_DIR/ghost-browser-relay-$VERSION.zip"
rm -f -- "$ZIP"

# `zip -X -@` from a sorted list: paths are relative to extension/, so the
# archive has no wrapper directory. -X drops the extra-field timestamps.
(
  cd -- "$SOURCE_DIR"
  find . -type f -printf '%P\n' | LC_ALL=C sort | zip -q -X -9 "$ZIP" -@
)

echo "$ZIP"
unzip -Z1 "$ZIP"
