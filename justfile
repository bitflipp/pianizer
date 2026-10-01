# Pianizer task runner. `just` alone lists recipes.

# Static-only: no server, no database — just the client, served over
# localhost (ES modules + Web MIDI need a secure context). Open the URL in
# a browser yourself; Ctrl-C stops the server.
run port="8000":
    python3 -m http.server {{ port }} -d "{{ justfile_directory() }}"

# Full app with server-side project storage. Requires PIANIZER_DB_DSN
# (a MariaDB DSN, e.g. user:pass@tcp(127.0.0.1:3306)/pianizer?parseTime=true).
# Serves frontend assets live from disk (-dev-assets), so editing index.html
# or ui/*.js needs no rebuild — just a browser refresh. Open the URL yourself.
#
# Built to a temp binary and exec'd directly rather than `go run`'d: `go run`
# execs the compiled binary as a *child* process of itself, so `server_pid=$!`
# would be the `go run` wrapper, not the server — killing it on exit leaves
# the real server orphaned and still holding the port, silently serving
# stale code next time this recipe runs.
run-server port="8000":
    #!/usr/bin/env bash
    set -euo pipefail
    : "${PIANIZER_DB_DSN:?set PIANIZER_DB_DSN to a MariaDB DSN, e.g. user:pass@tcp(127.0.0.1:3306)/pianizer?parseTime=true}"
    cd "{{ justfile_directory() }}"
    bin_dir="$(mktemp -d)"
    trap 'rm -rf "$bin_dir"' EXIT
    go build -o "$bin_dir/pianizer-server" ./cmd/server
    "$bin_dir/pianizer-server" -addr "localhost:{{ port }}" -dev-assets . &
    server_pid=$!
    trap 'kill "$server_pid" 2>/dev/null || true; rm -rf "$bin_dir"' EXIT
    wait "$server_pid"

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
