#!/usr/bin/env bash
# Build the Chrome Web Store upload zip: the contents of extension/ with
# manifest.json at the zip root, version-stamped from package.json.
#
#   contrib/package.sh              write /tmp/ghost-chromium-extension-<version>.zip
#   contrib/package.sh --out FILE   write FILE instead
#
# The zip is refused when extension/manifest.json disagrees with package.json
# about the version, so a forgotten bump cannot ship to the store.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
out=""

while (($# > 0)); do
  case "$1" in
    --out=*) out="${1#--out=}"; shift ;;
    --out)
      [[ $# -ge 2 ]] || { echo "package.sh: --out needs a value" >&2; exit 2; }
      out="$2"; shift 2
      ;;
    -h|--help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --*) echo "package.sh: unknown option $1" >&2; exit 2 ;;
    *)
      [[ -z "$out" ]] || { echo "package.sh: unexpected $1" >&2; exit 2; }
      out="$1"; shift
      ;;
  esac
done

read_version() {
  node -e 'let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => process.stdout.write(JSON.parse(s).version))'
}
version="$(read_version < "$root/package.json")"
manifest_version="$(read_version < "$root/extension/manifest.json")"
[[ "$version" == "$manifest_version" ]] || {
  echo "package.sh: package.json ($version) disagrees with extension/manifest.json ($manifest_version)" >&2
  exit 1
}

[[ -n "$out" ]] || out="/tmp/ghost-chromium-extension-$version.zip"
rm -f -- "$out"
(cd -- "$root/extension" && zip -X -q -r "$out" .)
echo "Wrote $out"
unzip -l "$out" | tail -n 3
