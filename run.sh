#!/usr/bin/env bash
# Launch Pianizer as a chromeless desktop app: serve the source tree over
# localhost (ES modules + Web MIDI need a secure context, which localhost is)
# and open it in a Chromium app-mode window. No build step, no dependencies.
set -euo pipefail

PORT="${PIANIZER_PORT:-8000}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://localhost:${PORT}"

# First Chromium-family browser found wins.
browser=""
for cand in chromium chromium-browser google-chrome google-chrome-stable brave brave-browser microsoft-edge; do
  if command -v "$cand" >/dev/null 2>&1; then
    browser="$cand"
    break
  fi
done
if [[ -z "$browser" ]]; then
  echo "run.sh: no Chromium-family browser found (need --app support)." >&2
  echo "Install one of: chromium, google-chrome, brave, microsoft-edge." >&2
  exit 1
fi

# Serve in the background; stop it when this script exits for any reason.
python3 -m http.server "$PORT" -d "$DIR" >/dev/null 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT

# Wait until the server answers before opening the window.
for _ in $(seq 1 50); do
  if exec 3<>"/dev/tcp/localhost/${PORT}" 2>/dev/null; then
    exec 3>&- 3<&-
    break
  fi
  sleep 0.1
done

# --app gives a window with no tab strip or address bar; blocks until closed.
# A dedicated profile makes Chromium spawn its own process (so the flags below
# apply even when another Chromium is already running) and persists the Web MIDI
# permission grant + window size across launches.
# GTK_CSD=0 + the X11 backend hand window decoration to GNOME, which draws its
# full-height themed title bar instead of Chromium's slim app-mode bar. This only
# works through XWayland; when DISPLAY is unset (no XWayland — e.g. a future
# Wayland-only GNOME) we skip those flags and launch a native Wayland window with
# Chromium's slim bar, so the launcher keeps working regardless.
# --class sets the window's WM_CLASS so a .desktop file's StartupWMClass=Pianizer
# matches it; without it the app-mode window gets an auto-generated class and the
# desktop shows a second, generic icon for the running window instead of ours.
PROFILE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pianizer/browser-profile"
deco=()
if [[ -n "${DISPLAY:-}" ]]; then
  export GTK_CSD=0
  deco=(--ozone-platform=x11)
fi
"$browser" "${deco[@]}" \
  --class=Pianizer \
  --user-data-dir="$PROFILE_DIR" \
  --app="$URL"
