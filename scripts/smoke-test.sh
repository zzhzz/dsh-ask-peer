#!/usr/bin/env bash
#
# Keyless three-instance smoke test for dsh-ask-peer.
#
# Prereqs (all already done by the project setup):
#   pnpm install
#   pnpm run build
#   pnpm add -D @deepseek-ai/dsh@0.1.0-rc.6
#
# What it proves:
#   - the bundle installs into real dsh profiles and boots;
#   - peers advertise tags/descriptions and the asker refreshes the roster;
#   - the inbound server enforces the caller allowlist and shared token;
#   - a direct ask reaches a fresh answering agent, which produces an answer
#     through the mock model endpoint;
#   - the answering agent's sandbox is read-only (a write attempt is denied
#     and leaves no file);
#   - the full model-driven loop works: Ada's agent lists peers, asks two of
#     them with ask_peers, and cross-validates both answers.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_DIR="${TMPDIR:-/tmp}/dsh-smoke"
DSH_HOME="$SMOKE_DIR/home"
PIDS=()

log() { printf '\n== %s ==\n' "$*"; }

cleanup() {
  printf '%s\n' "${PIDS[@]:-}" > "$SMOKE_DIR/live.pids"
  if [ "${KEEP_RUNNING:-0}" = "1" ]; then
    return
  fi
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

mkdir -p "$SMOKE_DIR/workspaces/ada" "$SMOKE_DIR/workspaces/bob" "$SMOKE_DIR/workspaces/carol" "$SMOKE_DIR/keys"

# Generate (or reuse) each agent's signing identity; the public sign is what
# friends configure as the trust root.
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

# 1. Create the profiles (base bundle + this plugin).
for side in ada bob carol; do
  if [ ! -d "$DSH_HOME/profiles/$side" ]; then
    log "creating profile $side"
    (cd "$ROOT" && DSH_HOME="$DSH_HOME" pnpm exec dsh plugin --profile "$side" add .)
  fi
done

# 2. Configure each side. Ada additionally gets the headless bundle so the
#    test can drive her agent as a one-shot task.
configure_side() {
  local side="$1" port="$2" workspace="$3" description="$4" tags="$5" headless="$6"
  local profile="$DSH_HOME/profiles/$side"

  case "$side" in
    ada)
      cat > "$profile/cordis.patch.yml" <<EOF
- id: ask-peer
  config:
    callerName: 'ada'
    keyDir: '$SMOKE_DIR/keys'
    listen: true
    listenHost: '127.0.0.1'
    listenPort: $port
    requireToken: true
    workspace: '$workspace'
    timeoutMs: 120000
    maxAnswerChars: 48000
    allowExecution: false
    description: '$description'
    tags: [$tags]
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
      ;;
    bob)
      cat > "$profile/cordis.patch.yml" <<EOF
- id: ask-peer
  config:
    callerName: 'bob'
    keyDir: '$SMOKE_DIR/keys'
    listen: true
    listenHost: '127.0.0.1'
    listenPort: $port
    requireToken: true
    workspace: '$workspace'
    timeoutMs: 120000
    maxAnswerChars: 48000
    approvalTimeoutMs: 3000
    allowExecution: false
    description: '$description'
    tags: [$tags]
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
      ;;
    carol)
      cat > "$profile/cordis.patch.yml" <<EOF
- id: ask-peer
  config:
    callerName: 'carol'
    keyDir: '$SMOKE_DIR/keys'
    listen: true
    listenHost: '127.0.0.1'
    listenPort: $port
    requireToken: true
    workspace: '$workspace'
    timeoutMs: 120000
    maxAnswerChars: 48000
    allowExecution: false
    description: '$description'
    tags: [$tags]
    rosterRefreshMs: 60000
    peers:
      - name: 'ada'
        host: '127.0.0.1'
        port: 3877
        token: 'smoke-secret'
        publicKey: '$ADA_PUB'
        mode: 'auto'
EOF
      ;;
  esac

  if [ "$headless" = "yes" ]; then
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
    ' "$profile/package.json"
  fi
}

configure_side ada 3877 "$SMOKE_DIR/workspaces/ada" 'Ada: asks around before acting' '' yes
configure_side bob 3878 "$SMOKE_DIR/workspaces/bob" 'Bob: environment setup expert' "'env-setup', 'docker'" no
configure_side carol 3879 "$SMOKE_DIR/workspaces/carol" 'Carol: testing and CI expert' "'testing', 'ci'" no

# 3. Start the mock model endpoints.
log "starting mock model endpoints"
MOCK_ROLE=answerer MOCK_PORT=9002 MOCK_ATTEMPT_WRITE=1 MOCK_ASK_LOOP=1 \
  MOCK_ANSWER='Answer: run `make dev` with NODE_ENV=development to stand up the environment.' \
  node "$ROOT/scripts/mock-llm.mjs" &
PIDS+=($!)
MOCK_ROLE=answerer MOCK_PORT=9003 \
  MOCK_ANSWER='Answer: run `docker compose up -d` to stand up the environment.' \
  node "$ROOT/scripts/mock-llm.mjs" &
PIDS+=($!)
MOCK_ROLE=asker MOCK_PORT=9001 MOCK_ASK_PEERS='bob,carol' node "$ROOT/scripts/mock-llm.mjs" &
PIDS+=($!)

# 4. Boot Bob's and Carol's dsh daemons (they host answering agents).
log "booting bob's and carol's dsh daemons"
DSH_HOME="$DSH_HOME" \
  DEEPSEEK_API_KEY=mock-key \
  DEEPSEEK_BASE_URL=http://127.0.0.1:9002/v1 \
  pnpm exec dsh --profile bob > "$SMOKE_DIR/bob.log" 2>&1 &
PIDS+=($!)
DSH_HOME="$DSH_HOME" \
  DEEPSEEK_API_KEY=mock-key \
  DEEPSEEK_BASE_URL=http://127.0.0.1:9003/v1 \
  pnpm exec dsh --profile carol > "$SMOKE_DIR/carol.log" 2>&1 &
PIDS+=($!)

wait_for_peer() {
  local port="$1" name="$2" logfile="$3"
  local ok=false
  for _ in $(seq 1 90); do
    if curl -sf "http://127.0.0.1:$port/health" 2>/dev/null | grep -q "\"peer\": *\"$name\""; then
      ok=true
      break
    fi
    sleep 1
  done
  if [ "$ok" != true ]; then
    echo "$name's ask server did not come up; log tail:" >&2
    tail -n 40 "$logfile" >&2
    exit 1
  fi
}
wait_for_peer 3878 bob "$SMOKE_DIR/bob.log"
wait_for_peer 3879 carol "$SMOKE_DIR/carol.log"

# 5. Advertisements carry the expected tags.
log "advert: peers advertise their tags"
curl -sf http://127.0.0.1:3878/advertise | grep -q 'env-setup' || { echo "bob advert missing tags" >&2; exit 1; }
curl -sf http://127.0.0.1:3879/advertise | grep -q 'testing' || { echo "carol advert missing tags" >&2; exit 1; }

# 6. Authorization checks against Bob's server.
log "authz: unknown caller must be rejected"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3878/ask \
  -H 'content-type: application/json' \
  -d '{"protocolVersion":1,"caller":"mallory","question":"hi"}')"
[ "$code" = "403" ] || { echo "expected 403 for unknown caller, got $code" >&2; exit 1; }

log "authz: an unauthorized (wrong-key) caller must be rejected"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3878/ask \
  -H 'content-type: application/json' \
  -d '{"protocolVersion":1,"caller":"ada","token":"wrong","question":"hi"}')"
[ "$code" = "403" ] || { echo "expected 403 for wrong token, got $code" >&2; exit 1; }

log "policy: a denied friend (mode: deny) must be rejected"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3878/ask \
  -H 'content-type: application/json' \
  -d '{"protocolVersion":1,"caller":"mallory","token":"smoke-secret","question":"hi"}')"
[ "$code" = "403" ] || { echo "expected 403 for denied friend, got $code" >&2; exit 1; }

log "policy: ask-mode without an answerer fails closed"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3878/ask \
  -H 'content-type: application/json' \
  -d '{"protocolVersion":1,"caller":"dave","token":"smoke-secret","question":"hi"}')"
[ "$code" = "403" ] || { echo "expected 403 for unavailable approval, got $code" >&2; exit 1; }

log "decision: browser preflight is answered"
code="$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS http://127.0.0.1:3878/ask/decision)"
[ "$code" = "204" ] || { echo "expected 204 for OPTIONS preflight, got $code" >&2; exit 1; }

log "decision: invalid decision token must be rejected"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3878/ask/decision \
  -H 'content-type: application/json' \
  -d '{"askId":"nonexistent","token":"nope","decision":"approve"}')"
[ "$code" = "403" ] || { echo "expected 403 for invalid decision token, got $code" >&2; exit 1; }

log "decision: malformed decision must be rejected"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3878/ask/decision \
  -H 'content-type: application/json' \
  -d '{}')"
[ "$code" = "400" ] || { echo "expected 400 for malformed decision, got $code" >&2; exit 1; }

log "settings: GET /settings exposes the section"
curl -sf http://127.0.0.1:3878/settings | grep -q 'uiToken' || {
  echo "settings endpoint did not expose uiToken" >&2
  exit 1
}

log "settings: a wrong write token must be rejected"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3878/settings \
  -H 'content-type: application/json' \
  -d '{"token":"nope","settings":{"description":"x","tags":[],"peers":[]}}')"
[ "$code" = "403" ] || { echo "expected 403 for wrong settings token, got $code" >&2; exit 1; }

log "settings: the correct token round-trips (echo write)"
curl -s http://127.0.0.1:3878/settings > "$SMOKE_DIR/settings.json"
node -e "
  const fs = require('node:fs')
  const doc = JSON.parse(fs.readFileSync('$SMOKE_DIR/settings.json', 'utf8'))
  fs.writeFileSync('$SMOKE_DIR/settings-payload.json', JSON.stringify({ token: doc.uiToken, settings: doc.settings }))
"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3878/settings \
  -H 'content-type: application/json' \
  --data @"$SMOKE_DIR/settings-payload.json")"
[ "$code" = "200" ] || { echo "expected 200 for valid settings write, got $code" >&2; exit 1; }

log "settings: GET /settings exposes the UI-editable local block"
curl -sf http://127.0.0.1:3878/settings | grep -q '"local"' || {
  echo "settings endpoint did not expose the local block" >&2
  exit 1
}

log "settings: local listenPort round-trips through the settings channel"
node -e "
  const fs = require('node:fs')
  const doc = JSON.parse(fs.readFileSync('$SMOKE_DIR/settings.json', 'utf8'))
  doc.settings.local.listenPort = 3898
  fs.writeFileSync('$SMOKE_DIR/settings-local.json', JSON.stringify({ token: doc.uiToken, settings: doc.settings }))
"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3878/settings \
  -H 'content-type: application/json' \
  --data @"$SMOKE_DIR/settings-local.json")"
[ "$code" = "200" ] || { echo "expected 200 for local settings write, got $code" >&2; exit 1; }
curl -sf http://127.0.0.1:3878/settings | grep -q '3898' || {
  echo "local listenPort change was not persisted" >&2
  exit 1
}
node -e "
  const fs = require('node:fs')
  const doc = JSON.parse(fs.readFileSync('$SMOKE_DIR/settings.json', 'utf8'))
  fs.writeFileSync('$SMOKE_DIR/settings-restore.json', JSON.stringify({ token: doc.uiToken, settings: doc.settings }))
"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3878/settings \
  -H 'content-type: application/json' \
  --data @"$SMOKE_DIR/settings-restore.json")"
[ "$code" = "200" ] || { echo "expected 200 restoring settings, got $code" >&2; exit 1; }

log "card: GET /sign/card returns a signed friend card"
CARD="$(curl -sf http://127.0.0.1:3878/sign/card | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).card))")"
case "$CARD" in
  dsh-ask-peer-card:*) ;;
  *) echo "card prefix missing" >&2; exit 1 ;;
esac

log "card: the valid card decodes and verifies"
curl -sf -X POST http://127.0.0.1:3878/sign/verify \
  -H 'content-type: application/json' \
  -d "{\"card\":\"$CARD\"}" | grep -q '"ok":true' || {
  echo "valid friend card was rejected" >&2
  exit 1
}

log "card: a tampered card must be rejected"
TAMPERED="$(node -e "const c=process.argv[1];const i=Math.floor(c.length/2);const ch=c[i]==='A'?'B':'A';process.stdout.write(c.slice(0,i)+ch+c.slice(i+1))" "$CARD")"
curl -sf -X POST http://127.0.0.1:3878/sign/verify \
  -H 'content-type: application/json' \
  -d "{\"card\":\"$TAMPERED\"}" | grep -q '"ok":false' || {
  echo "tampered friend card was accepted" >&2
  exit 1
}

log "async: an unknown askId must 404"
code="$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3878/ask/status?askId=nonexistent')"
[ "$code" = "404" ] || { echo "expected 404 for unknown askId, got $code" >&2; exit 1; }

# 7. Direct client ask against Bob's server. Bob's answering agent attempts a
#    workspace write; the read-only sandbox must deny it.
log "client: signed direct ask_peer against bob (with a denied write attempt)"
node --input-type=module -e "
  import { loadOrCreateIdentity } from '$ROOT/lib/identity.js'
  import { askPeer } from '$ROOT/lib/peer-client.js'
  const identity = loadOrCreateIdentity('$SMOKE_DIR/keys', 'ada')
  const result = await askPeer(
    { name: 'bob', host: '127.0.0.1', port: 3878, publicKey: '$BOB_PUB' },
    { callerName: 'ada', identity },
    'How do I stand up the dev environment?',
  )
  console.log('answer:', result.answer)
  if (!result.answer.includes('make dev')) {
    console.error('answer did not contain the expected content')
    process.exit(1)
  }
"
if [ -e "$SMOKE_DIR/workspaces/bob/pwned.txt" ]; then
  echo "FAIL: the answering agent modified bob's workspace" >&2
  exit 1
fi
log "read-only sandbox held: no pwned.txt in bob's workspace"

log "client: async (backlogged) ask_peer against bob"
node --input-type=module -e "
  import { loadOrCreateIdentity } from '$ROOT/lib/identity.js'
  import { askPeerAsync, pollAsk } from '$ROOT/lib/peer-client.js'
  const identity = loadOrCreateIdentity('$SMOKE_DIR/keys', 'ada')
  const peer = { name: 'bob', host: '127.0.0.1', port: 3878, publicKey: '$BOB_PUB' }
  const { askId } = await askPeerAsync(
    peer,
    { callerName: 'ada', identity },
    'How do I stand up the dev environment? (async)',
  )
  console.log('askId:', askId)
  const result = await pollAsk(peer, askId, 120000)
  console.log('status:', result.status)
  console.log('answer:', result.answer)
  if (result.status !== 'answered' || !result.answer.includes('make dev')) {
    console.error('async ask did not produce the expected answer')
    process.exit(1)
  }
"

log "identity: an impostor signature must be rejected"
node --input-type=module -e "
  import { generateKeyPairSync } from 'node:crypto'
  import { askPeer } from '$ROOT/lib/peer-client.js'
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const impostor = {
    publicKey: 'ed25519:' + Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }
  try {
    await askPeer(
      { name: 'bob', host: '127.0.0.1', port: 3878, publicKey: '$BOB_PUB' },
      { callerName: 'ada', identity: impostor },
      'impostor check',
    )
    console.error('impostor ask was accepted')
    process.exit(1)
  } catch (error) {
    console.log('impostor rejected:', String(error).split('\n')[0])
    if (!String(error).includes('403')) process.exit(1)
  }
"

# 8. Full model-driven loop: Ada lists peers, asks bob+carol, cross-validates.
log "e2e: ada's headless task (peers_list -> ask_peers -> cross-validated answer)"
OUT="$(DSH_HOME="$DSH_HOME" \
  DEEPSEEK_API_KEY=mock-key \
  DEEPSEEK_BASE_URL=http://127.0.0.1:9001/v1 \
  pnpm exec dsh --profile ada "How do I stand up the dev environment?")"
printf '%s\n' "$OUT"
for needle in 'env-setup' 'make dev' 'docker compose'; do
  if ! grep -q "$needle" <<<"$OUT"; then
    echo "ada's output is missing: $needle" >&2
    exit 1
  fi
done

log "smoke test passed"

if [ "${KEEP_RUNNING:-0}" = "1" ]; then
  log "keeping processes running: bob=127.0.0.1:3878 carol=127.0.0.1:3879 mocks=9001-9003 (Ctrl-C stops everything)"
  tail -f /dev/null
fi
