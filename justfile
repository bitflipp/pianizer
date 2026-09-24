# Pianizer task runner. `just` alone lists recipes.

# Chromium-family browser launch shared by `run` and `run-server`: no tab
# strip or address bar, a dedicated profile so Web MIDI permission grants
# and window size persist, and GNOME-drawn decoration under XWayland.
_launch url:
    #!/usr/bin/env bash
    set -euo pipefail
    browser=""
    for cand in chromium chromium-browser google-chrome google-chrome-stable brave brave-browser microsoft-edge; do
      if command -v "$cand" >/dev/null 2>&1; then browser="$cand"; break; fi
    done
    if [[ -z "$browser" ]]; then
      echo "just: no Chromium-family browser found (need --app support)." >&2
      echo "Install one of: chromium, google-chrome, brave, microsoft-edge." >&2
      exit 1
    fi
    profile_dir="${XDG_DATA_HOME:-$HOME/.local/share}/pianizer/browser-profile"
    deco=()
    if [[ -n "${DISPLAY:-}" ]]; then
      export GTK_CSD=0
      deco=(--ozone-platform=x11)
    fi
    "$browser" "${deco[@]}" --class=Pianizer --user-data-dir="$profile_dir" --app="{{ url }}"

# Wait until something answers on localhost:port before returning.
_wait-for-port port:
    #!/usr/bin/env bash
    set -euo pipefail
    for _ in $(seq 1 50); do
      if exec 3<>"/dev/tcp/localhost/{{ port }}" 2>/dev/null; then exec 3>&- 3<&-; break; fi
      sleep 0.1
    done

# Static-only desktop app: no server, no database — just the client, served
# over localhost (ES modules + Web MIDI need a secure context).
run port="8000":
    #!/usr/bin/env bash
    set -euo pipefail
    python3 -m http.server {{ port }} -d "{{ justfile_directory() }}" >/dev/null 2>&1 &
    server_pid=$!
    trap 'kill "$server_pid" 2>/dev/null || true' EXIT
    just _wait-for-port {{ port }}
    just _launch "http://localhost:{{ port }}"

# Full desktop app with server-side project storage. Requires PIANIZER_DB_DSN
# (a MariaDB DSN, e.g. user:pass@tcp(127.0.0.1:3306)/pianizer?parseTime=true).
# Serves frontend assets live from disk (-dev-assets), so editing index.html
# or ui/*.js needs no rebuild — just a browser refresh.
run-server port="8000":
    #!/usr/bin/env bash
    set -euo pipefail
    : "${PIANIZER_DB_DSN:?set PIANIZER_DB_DSN to a MariaDB DSN, e.g. user:pass@tcp(127.0.0.1:3306)/pianizer?parseTime=true}"
    cd "{{ justfile_directory() }}"
    go run ./cmd/server -addr "localhost:{{ port }}" -dev-assets . &
    server_pid=$!
    trap 'kill "$server_pid" 2>/dev/null || true' EXIT
    just _wait-for-port {{ port }}
    just _launch "http://localhost:{{ port }}"

# Build a single production binary with the frontend embedded.
build:
    go build -o pianizer ./cmd/server

# Full test suite: Vitest engine tests + Playwright UI tests.
test:
    npm test

test-engine:
    npm run test:engine

test-ui:
    npm run test:ui

# Go store/API tests — no MariaDB needed, they run against an in-memory Store.
test-go:
    go test ./...
