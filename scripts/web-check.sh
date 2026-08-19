#!/usr/bin/env bash
#
# Verify the browser half of dsh-ask-peer: a real dsh web profile must
# discover the package's dsh.client declaration, inject it into the boot
# manifest, and serve the built client bundle.
#
# Prereqs: pnpm install && pnpm run build (build emits lib/client.js).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_DIR="${TMPDIR:-/tmp}/dsh-smoke"
DSH_HOME="$SMOKE_DIR/home"
PIDS=()

log() { printf '\n== %s ==\n' "$*"; }

# Preflight: the web UI port must be free (a running dsh instance would
# collide and make the check fail confusingly).
log "preflight: port 3080 must be free"
if lsof -iTCP:3080 -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
  echo "port 3080 is already in use — stop the other dsh instance first" >&2
  echo "  kill \$(lsof -tiTCP:3080 -sTCP:LISTEN)" >&2
  exit 1
fi

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

# Create (or repair) the web profile: the bundle must be listed in the
# profile manifest, or the ask-peer row has no plugin to resolve.
if [ ! -f "$DSH_HOME/profiles/web/package.json" ] ||
  ! node -e "
    const p = require(process.argv[1])
    process.exit(p.dsh?.profile?.bundles?.includes('dsh-ask-peer') ? 0 : 1)
  " "$DSH_HOME/profiles/web/package.json" 2>/dev/null; then
  log "creating web profile with the plugin"
  rm -rf "$DSH_HOME/profiles/web"
  (cd "$ROOT" && DSH_HOME="$DSH_HOME" pnpm exec dsh plugin --profile web add .)
fi

log "booting dsh web"
DSH_HOME="$DSH_HOME" \
  DEEPSEEK_API_KEY=mock-key \
  DEEPSEEK_BASE_URL=http://127.0.0.1:9002/v1 \
  pnpm exec dsh --profile web > "$SMOKE_DIR/web.log" 2>&1 &
PIDS+=($!)

log "waiting for the web UI"
ok=false
for _ in $(seq 1 120); do
  if curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/ 2>/dev/null | grep -q '200'; then
    ok=true
    break
  fi
  sleep 1
done
if [ "$ok" != true ]; then
  echo "web UI did not come up; log tail:" >&2
  tail -n 60 "$SMOKE_DIR/web.log" >&2
  exit 1
fi

log "boot manifest includes the ask-peer plugin row"
curl -s http://127.0.0.1:3080/ | grep -q 'dsh-ask-peer' || {
  echo "boot manifest missing dsh-ask-peer" >&2
  exit 1
}

log "client bundle is served"
ok=false
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:3080/plugins/dsh-ask-peer/client.js 2>/dev/null | grep -q '__ModuleLoader__.load'; then
    ok=true
    break
  fi
  sleep 1
done
if [ "$ok" != true ]; then
  echo "client bundle missing or malformed" >&2
  tail -n 60 "$SMOKE_DIR/web.log" >&2
  exit 1
fi

log "same-origin config route is served"
curl -sf http://127.0.0.1:3080/ask-peer/config | grep -q 'serverUrl' || {
  echo "config route missing serverUrl" >&2
  exit 1
}

log "pending-friends route is served"
curl -sf http://127.0.0.1:3080/ask-peer/pending-friends | grep -q '\[\]' || {
  echo "pending-friends route did not return an empty list" >&2
  exit 1
}

log "web check passed: browser half discovered and served"
