#!/usr/bin/env bash
# Store screenshots, reproducibly: a private nested Hyprland with a headless
# 1280x800 output, a throwaway Chromium with this repository loaded unpacked,
# the real side panel opened, and grim capturing that output alone — nothing
# on the owner's desktop can leak into a capture, and nothing on it can stall
# one. Writes store/screenshots/{1-conversation,2-consent,3-menu}.png.
#
#   contrib/store-screenshots/capture.sh
#
# Needs Hyprland (as the running desktop), grim, magick, node, chromium. The
# transcript shown is seeded (driver.mjs); the UI is the real extension.
set -Eeuo pipefail
S=$(cd -- "$(dirname -- "$0")" && pwd); EXT=$(cd -- "$S/../.." && pwd); OUT=${OUT:-$EXT/store/screenshots}
mkdir -p "$OUT"
parent_socket=$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY; parent_instance=$HYPRLAND_INSTANCE_SIGNATURE; parent_runtime=$XDG_RUNTIME_DIR
root=$(mktemp -d /tmp/ghs.XXXXXX); chmod 700 "$root"; mkdir -p "$root"/{home,config,cache}
hypr_pid=""
# The compositor's own pid is line 1 of the lock file in our private runtime
# root; $hypr_pid may be setsid's. Both were spawned here.
cleanup() { for lock in "$root"/hypr/*/hyprland.lock; do [[ -f $lock ]] && kill "$(sed -n 1p "$lock")" 2>/dev/null || true; done; [[ -n $hypr_pid ]] && kill "$hypr_pid" 2>/dev/null || true; sleep 0.5; rm -rf "$root"; }
trap cleanup EXIT
cat > "$root/hyprland.lua" <<'LUA'
hl.monitor({ output = "HEADLESS-1", mode = "1280x800@60", position = "5000x0", scale = 1 })
hl.config({
  general = { gaps_in = 0, gaps_out = 0, border_size = 0 },
  decoration = { rounding = 0, shadow = { enabled = false }, blur = { enabled = false } },
  animations = { enabled = false },
  cursor = { inactive_timeout = 1 },
  misc = { disable_hyprland_logo = true, disable_splash_rendering = true },
})
LUA
export HOME=$root/home XDG_CONFIG_HOME=$root/config XDG_CACHE_HOME=$root/cache XDG_RUNTIME_DIR=$root
unset HYPRLAND_INSTANCE_SIGNATURE
setsid env WAYLAND_DISPLAY="$parent_socket" Hyprland --config "$root/hyprland.lua" >"$root/hyprland.log" 2>&1 &
hypr_pid=$!
sig=""; disp=""
for _ in {1..120}; do
  kill -0 "$hypr_pid" 2>/dev/null || { echo "nested Hyprland died"; sed -n '1,40p' "$root/hyprland.log"; exit 1; }
  for d in "$XDG_RUNTIME_DIR"/hypr/*; do
    [[ -S $d/.socket.sock && -f $d/hyprland.lock ]] || continue
    cand=$(sed -n '2p' "$d/hyprland.lock"); [[ -n $cand && -S $XDG_RUNTIME_DIR/$cand ]] || continue
    sig=$(basename "$d"); disp=$cand; break 2
  done
  sleep 0.1
done
[[ -n $sig ]] || { echo "no nested socket"; sed -n '1,40p' "$root/hyprland.log"; exit 1; }
export HYPRLAND_INSTANCE_SIGNATURE=$sig WAYLAND_DISPLAY=$disp
# A headless output inside the nested compositor renders on its own clock, so
# what is or is not visible on the owner's desktop cannot stall a capture.
hyprctl output create headless HEADLESS-1 >/dev/null
for _ in {1..50}; do
  size=$(hyprctl monitors -j | python3 -c 'import json,sys; ms=[m for m in json.load(sys.stdin) if m["name"]=="HEADLESS-1"]; print(str(ms[0]["width"])+" "+str(ms[0]["height"]) if ms else "")')
  [[ $size == "1280 800" ]] && break; sleep 0.2
done
echo "headless output: ${size:-missing}"
hyprctl dismissnotify >/dev/null 2>&1 || true
EXT=$EXT OUT=$OUT node "$S/driver.mjs"
