#!/usr/bin/env bash
#
# Real-model test for dsh-ask-peer: no mocks. Requires a DeepSeek API key.
#
# Key resolution: $DEEPSEEK_API_KEY environment variable, or a root .env file
# containing DEEPSEEK_API_KEY=sk-... (gitignored).
#
# What it verifies with real model traffic:
#   1. a signed direct ask reaches Bob's fresh answering agent, which answers
#      using the real model while reading the plugin repo (read-only sandbox);
#   2. Ada's agent (real model) calls ask_peer on her own and relays Bob's
#      real answer back.
#
# Usage: bash scripts/real-test.sh ["question for bob"]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_DIR="${TMPDIR:-/tmp}/dsh-smoke"
DSH_HOME="$SMOKE_DIR/home"
PIDS=()
DEFAULT_QUESTION="Use ask_peer to ask bob's agent: How does the dsh-ask-peer plugin authenticate an ask request?"
QUESTION="${1:-$DEFAULT_QUESTION}"

log() { printf '\n== %s ==\n' "$*"; }

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

mkdir -p "$SMOKE_DIR/keys"

# Generate (or reuse) each agent's signing identity — the same key material
# the smoke suite uses.
gen_identity() {
  local name="$1"
  node -e '
    const { generateKeyPairSync } = require("node:crypto")
    const fs = require("node:fs")
    const path = require("node:path")
    const dir = process.argv[1]
    const name = process.argv[2]
    const pubFile = path.join(dir, name + ".pub")
    const keyFile = path.join(dir, name + ".key")
    if (fs.existsSync(pubFile) && fs.existsSync(keyFile)) {
      process.stdout.write(fs.readFileSync(pubFile, "utf8").trim())
      return
    }
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const sign = "ed25519:" + Buffer.from(publicKey.export({ type: "spki", format: "pem" })).toString("base64url")
    fs.writeFileSync(pubFile, sign + "\n", { mode: 0o644 })
    fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
    process.stdout.write(sign)
  ' "$SMOKE_DIR/keys" "$name"
}

ADA_PUB="$(gen_identity ada)"
BOB_PUB="$(gen_identity bob)"
CAROL_PUB="$(gen_identity carol)"

# Key resolution: env first, then workspace .env.
if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi
if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "No DEEPSEEK_API_KEY found." >&2
  echo "Export it, or create $ROOT/.env (gitignored) with: DEEPSEEK_API_KEY=sk-..." >&2
  exit 2
fi
log "using the real DeepSeek API (base: ${DEEPSEEK_BASE_URL:-official})"

# Profiles: create on first use.
for side in ada bob; do
  if [ ! -d "$DSH_HOME/profiles/$side" ]; then
    log "creating profile $side"
    (cd "$ROOT" && DSH_HOME="$DSH_HOME" pnpm exec dsh plugin --profile "$side" add .)
  fi
done

# Bob answers from the plugin repo itself, so the question has real material.
cat > "$DSH_HOME/profiles/bob/cordis.patch.yml" <<EOF
- id: ask-peer
  config:
    callerName: 'bob'
    keyDir: '$SMOKE_DIR/keys'
    listen: true
    listenHost: '127.0.0.1'
    listenPort: 3878
    requireToken: true
    workspace: '$ROOT'
    timeoutMs: 180000
    maxAnswerChars: 48000
    approvalTimeoutMs: 120000
    allowExecution: false
    description: 'Bob: environment setup expert'
    tags: ['env-setup', 'docker']
    rosterRefreshMs: 60000
    peers:
      - name: 'ada'
        host: '127.0.0.1'
        port: 3877
        token: 'smoke-secret'
        publicKey: '$ADA_PUB'
        mode: 'auto'
      - name: 'mallory'
        host: '127.0.0.1'
        port: 1
        token: 'smoke-secret'
        mode: 'deny'
      - name: 'dave'
        host: '127.0.0.1'
        port: 1
        token: 'smoke-secret'
        mode: 'ask'
EOF

# Ada asks (headless one-shot); make sure her profile carries the headless bundle.
cat > "$DSH_HOME/profiles/ada/cordis.patch.yml" <<EOF
- id: ask-peer
  config:
    callerName: 'ada'
    keyDir: '$SMOKE_DIR/keys'
    listen: true
    listenHost: '127.0.0.1'
    listenPort: 3877
    requireToken: true
    workspace: '$SMOKE_DIR/workspaces/ada'
    timeoutMs: 180000
    maxAnswerChars: 48000
    approvalTimeoutMs: 120000
    allowExecution: false
    description: 'Ada: asks around before acting'
    tags: []
    rosterRefreshMs: 60000
    peers:
      - name: 'bob'
        host: '127.0.0.1'
        port: 3878
        token: 'smoke-secret'
        publicKey: '$BOB_PUB'
        mode: 'auto'
      - name: 'carol'
        host: '127.0.0.1'
        port: 3879
        token: 'smoke-secret'
        publicKey: '$CAROL_PUB'
        mode: 'auto'
EOF

node -e '
  const fs = require("node:fs")
  const file = process.argv[1]
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes("@deepseek-ai/dsh-headless")) {
    const base = bundles.indexOf("@deepseek-ai/dsh-base")
    bundles.splice(base + 1, 0, "@deepseek-ai/dsh-headless")
  }
  manifest.dsh.profile.bundles = bundles
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
' "$DSH_HOME/profiles/ada/package.json"

# Boot Bob's answering daemon.
log "booting bob (real model)"
DSH_HOME="$DSH_HOME" \
  DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  ${DEEPSEEK_BASE_URL:+DEEPSEEK_BASE_URL="$DEEPSEEK_BASE_URL"} \
  pnpm exec dsh --profile bob > "$SMOKE_DIR/real-bob.log" 2>&1 &
PIDS+=($!)

ok=false
for _ in $(seq 1 120); do
  if curl -sf http://127.0.0.1:3878/health 2>/dev/null | grep -q '"peer": *"bob"'; then
    ok=true
    break
  fi
  sleep 1
done
if [ "$ok" != true ]; then
  echo "bob did not come up; log tail:" >&2
  tail -n 60 "$SMOKE_DIR/real-bob.log" >&2
  exit 1
fi

# 1. Signed direct ask through the compiled client (deterministic path).
log "direct signed ask to bob (real answer)"
node --input-type=module -e "
  import { loadOrCreateIdentity } from '$ROOT/lib/identity.js'
  import { askPeer } from '$ROOT/lib/peer-client.js'
  const fs = await import('node:fs')
  const identity = loadOrCreateIdentity('$SMOKE_DIR/keys', 'ada')
  const bobPub = fs.readFileSync('$SMOKE_DIR/keys/bob.pub', 'utf8').trim()
  const result = await askPeer(
    { name: 'bob', host: '127.0.0.1', port: 3878, publicKey: bobPub },
    { callerName: 'ada', identity },
    'How does the dsh-ask-peer plugin authenticate an ask request?',
  )
  console.log('answer:', result.answer)
  if (result.answer.trim().length === 0) {
    console.error('empty answer'); process.exit(1)
  }
"

# 2. Ada's own agent drives ask_peer with the real model.
log "ada's headless task (real model calls ask_peer)"
OUT="$(DSH_HOME="$DSH_HOME" \
  DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  ${DEEPSEEK_BASE_URL:+DEEPSEEK_BASE_URL="$DEEPSEEK_BASE_URL"} \
  pnpm exec dsh --profile ada "$QUESTION")"
printf '%s\n' "$OUT"
if [ -z "${OUT// /}" ]; then
  echo "ada produced no output" >&2
  exit 1
fi

log "real test passed (real model traffic)"
