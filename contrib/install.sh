#!/usr/bin/env bash
# Install the Ghost browser relay extension for Chromium on Omarchy/Arch.
#
# There is nothing to build: the extension is plain ES modules and a manifest.
# "Installing" means putting the directory somewhere stable that survives a
# `pnpm install` or a package upgrade, and then telling Chromium about it once.
#
#   contrib/install.sh              copy into ~/.local/share/ghost/chromium-extension
#   contrib/install.sh --link       symlink instead (for hacking on the extension)
#   contrib/install.sh --launch     also start a THROWAWAY Chromium with it loaded
#   contrib/install.sh --uninstall  remove the installed copy
#
# Chromium on Linux has no supported way to install an unpacked extension for an
# already-running profile from the command line: `--load-extension` only applies
# to the profile a fresh process starts with, and Chrome ≥ 137 ignores it entirely
# for the default profile unless the extension is also allowlisted by policy. So
# the honest instruction for the owner's real, signed-in browser is the manual
# one — chrome://extensions, Developer mode, "Load unpacked" — and this script
# gets the files to a permanent path and prints exactly what to click.
set -euo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../extension" && pwd)"
TARGET_DIR="${GHOST_EXTENSION_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/ghost/chromium-extension}"

mode="copy"
launch=0
for arg in "$@"; do
  case "$arg" in
    --link) mode="link" ;;
    --launch) launch=1 ;;
    --uninstall) mode="uninstall" ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done

find_chromium() {
  for candidate in "${GHOST_BROWSER_EXECUTABLE:-}" chromium chromium-browser google-chrome-stable google-chrome; do
    [ -n "$candidate" ] || continue
    if command -v "$candidate" >/dev/null 2>&1; then command -v "$candidate"; return 0; fi
  done
  return 1
}

if [ "$mode" = "uninstall" ]; then
  rm -rf -- "$TARGET_DIR"
  echo "Removed $TARGET_DIR"
  echo "Also remove it from chrome://extensions if you loaded it there."
  exit 0
fi

mkdir -p -- "$(dirname -- "$TARGET_DIR")"
rm -rf -- "$TARGET_DIR"
if [ "$mode" = "link" ]; then
  ln -s -- "$SOURCE_DIR" "$TARGET_DIR"
  echo "Linked $TARGET_DIR -> $SOURCE_DIR"
else
  cp -r -- "$SOURCE_DIR" "$TARGET_DIR"
  echo "Installed to $TARGET_DIR"
fi

cat <<EOF

Next, in the browser you actually use:

  1. Open  chrome://extensions
  2. Turn on "Developer mode" (top right)
  3. "Load unpacked" -> $TARGET_DIR
  4. Pin "Ghost browser relay" and click it
  5. Run  ghostd relay-token  in a terminal, paste the token, "Save & connect"

The badge reads "on" once it is paired and ghostd is running.

EOF

if [ "$launch" -eq 1 ]; then
  if ! CHROMIUM="$(find_chromium)"; then
    echo "No chromium found; install it with: sudo pacman -S chromium" >&2
    exit 1
  fi
  PROFILE="$(mktemp -d -t ghost-relay-profile-XXXXXX)"
  echo "Starting a THROWAWAY Chromium (profile: $PROFILE)."
  echo "This is not your real browser and has none of your logins."
  "$CHROMIUM" \
    --user-data-dir="$PROFILE" \
    --load-extension="$TARGET_DIR" \
    --no-first-run \
    --no-default-browser-check \
    --password-store=basic \
    about:blank
  rm -rf -- "$PROFILE"
fi
