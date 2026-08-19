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
#   - friend recommendations work: authenticated /recommend with topic
#     matching, the model-driven recommend_peer tool call, the pending
#     notification, and the owner's Add decision merging the new friend;
#   - bounded transitive discovery works: a recommendation is forwarded one
#     hop (ada -> carol -> bob -> erin) with loop prevention and a via chain;
#   - the full model-driven loop works: Ada's agent lists peers, asks two of
#     them with ask_peers, and cross-validates both answers.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_DIR="${TMPDIR:-/tmp}/dsh-smoke"
DSH_HOME="$SMOKE_DIR/home"
PIDS=()

log() { printf '\n== %s ==\n' "$*"; }

# Preflight: every port the smoke test uses must be free, or a leftover dsh
# instance (e.g. a real browser test you forgot to stop) will make the run
# fail in confusing ways.
log "preflight: test ports must be free"
for port in 3080 3877 3878 3879 3890 9001 9002 9003 9004; do
  if lsof -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
    echo "port $port is already in use — stop the other dsh instance first" >&2
    echo "  kill \$(lsof -tiTCP:$port -sTCP:LISTEN)" >&2
    exit 1
  fi
done

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

mkdir -p "$SMOKE_DIR/workspaces/ada" "$SMOKE_DIR/workspaces/bob" "$SMOKE_DIR/workspaces/carol" "$SMOKE_DIR/workspaces/erin" "$SMOKE_DIR/keys"

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
ERIN_PUB="$(gen_identity erin)"

# The plugin's settings file overrides the profile patch, so stale files from
# earlier runs would silently change the friend graph. Start from the profile
# values every run (keys are kept).
rm -f "$SMOKE_DIR/keys/settings-ada.json" "$SMOKE_DIR/keys/settings-bob.json" "$SMOKE_DIR/keys/settings-carol.json" "$SMOKE_DIR/keys/settings-erin.json"

# 1. Create (or repair) the profiles: the bundle must be listed in the
#    profile manifest, or the ask-peer row has no plugin to resolve.
ensure_profile() {
  local side="$1"
  if [ -f "$DSH_HOME/profiles/$side/package.json" ] &&
    node -e "
      const p = require(process.argv[1])
      process.exit(p.dsh?.profile?.bundles?.includes('dsh-ask-peer') ? 0 : 1)
    " "$DSH_HOME/profiles/$side/package.json" 2>/dev/null; then
    return
  fi
  log "creating profile $side"
  rm -rf "$DSH_HOME/profiles/$side"
  (cd "$ROOT" && DSH_HOME="$DSH_HOME" pnpm exec dsh plugin --profile "$side" add .)
}
for side in ada bob carol erin; do
  ensure_profile "$side"
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
    rosterRefreshMs: 2000
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
      - name: 'carol'
        host: '127.0.0.1'
        port: 3879
        token: 'smoke-secret'
        publicKey: '$CAROL_PUB'
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
      - name: 'erin'
        host: '127.0.0.1'
        port: 3890
        token: 'smoke-secret'
        publicKey: '$ERIN_PUB'
        mode: 'auto'
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
    rosterRefreshMs: 2000
    peers:
      - name: 'ada'
        host: '127.0.0.1'
        port: 3877
        token: 'smoke-secret'
        publicKey: '$ADA_PUB'
        mode: 'auto'
      - name: 'bob'
        host: '127.0.0.1'
        port: 3878
        token: 'smoke-secret'
        publicKey: '$BOB_PUB'
        mode: 'auto'
EOF
      ;;
    erin)
      cat > "$profile/cordis.patch.yml" <<EOF
- id: ask-peer
  config:
    callerName: 'erin'
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
    rosterRefreshMs: 2000
    peers:
      - name: 'bob'
        host: '127.0.0.1'
        port: 3878
        token: 'smoke-secret'
        publicKey: '$BOB_PUB'
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
configure_side erin 3890 "$SMOKE_DIR/workspaces/erin" 'Erin: kubernetes expert' "'kubernetes', 'k8s'" no

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
MOCK_ROLE=answerer MOCK_PORT=9004 \
  MOCK_ANSWER='Answer: apply the k8s manifest with kubectl apply -f.' \
  node "$ROOT/scripts/mock-llm.mjs" &
PIDS+=($!)
MOCK_ROLE=asker MOCK_PORT=9001 MOCK_ASK_PEERS='bob,carol' node "$ROOT/scripts/mock-llm.mjs" &
PIDS+=($!)

# 4. Boot the dsh daemons (they host answering agents).
log "booting bob, carol, and erin dsh daemons"
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
DSH_HOME="$DSH_HOME" \
  DEEPSEEK_API_KEY=mock-key \
  DEEPSEEK_BASE_URL=http://127.0.0.1:9004/v1 \
  pnpm exec dsh --profile erin > "$SMOKE_DIR/erin.log" 2>&1 &
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
wait_for_peer 3890 erin "$SMOKE_DIR/erin.log"

# 5. Advertisements carry the expected tags.
log "advert: peers advertise their tags"
curl -sf http://127.0.0.1:3878/advertise | grep -q 'env-setup' || { echo "bob advert missing tags" >&2; exit 1; }
curl -sf http://127.0.0.1:3879/advertise | grep -q 'testing' || { echo "carol advert missing tags" >&2; exit 1; }
curl -sf http://127.0.0.1:3890/advertise | grep -q 'kubernetes' || { echo "erin advert missing tags" >&2; exit 1; }

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

log "recommend: unknown caller must be rejected"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3879/recommend \
  -H 'content-type: application/json' \
  -d '{"protocolVersion":1,"caller":"mallory","topic":"env-setup"}')"
[ "$code" = "403" ] || { echo "expected 403 for unknown recommend caller, got $code" >&2; exit 1; }

log "recommend: a wrong token must be rejected"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3879/recommend \
  -H 'content-type: application/json' \
  -d '{"protocolVersion":1,"caller":"ada","token":"wrong","topic":"env-setup"}')"
[ "$code" = "403" ] || { echo "expected 403 for wrong recommend token, got $code" >&2; exit 1; }

log "recommend: signed request from ada to carol returns bob's card"
RECOMMEND_JSON="$(node --input-type=module -e "
  import { loadOrCreateIdentity } from '$ROOT/lib/identity.js'
  import { requestRecommendation } from '$ROOT/lib/peer-client.js'
  const identity = loadOrCreateIdentity('$SMOKE_DIR/keys', 'ada')
  const peer = { name: 'carol', host: '127.0.0.1', port: 3879, publicKey: '$CAROL_PUB' }
  let result
  for (let i = 0; i < 20; i++) {
    try {
      // The exact topic Bob used in the real test that 404'd; locks the
      // live-advertisement matching regression.
      result = await requestRecommendation(peer, { callerName: 'ada', identity }, 'docker-compose dev environment')
      break
    } catch (error) {
      if (i === 19) throw error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  console.log(JSON.stringify(result))
")"
echo "$RECOMMEND_JSON" | grep -q '"from":"bob"' || { echo "recommend did not pick bob" >&2; exit 1; }
REC_CARD="$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write(d.card)" "$RECOMMEND_JSON")"
case "$REC_CARD" in
  dsh-ask-peer-card:*) ;;
  *) echo "recommended card prefix missing" >&2; exit 1 ;;
esac
curl -sf -X POST http://127.0.0.1:3878/sign/verify \
  -H 'content-type: application/json' \
  -d "{\"card\":\"$REC_CARD\"}" | grep -q '"ok":true' || {
  echo "recommended card failed verification" >&2
  exit 1
}

log "recommend: a non-matching topic falls back to the best-known friend"
GENERAL_JSON="$(node --input-type=module -e "
  import { loadOrCreateIdentity } from '$ROOT/lib/identity.js'
  import { requestRecommendation } from '$ROOT/lib/peer-client.js'
  const identity = loadOrCreateIdentity('$SMOKE_DIR/keys', 'ada')
  const result = await requestRecommendation(
    { name: 'carol', host: '127.0.0.1', port: 3879, publicKey: '$CAROL_PUB' },
    { callerName: 'ada', identity },
    'general',
  )
  console.log(JSON.stringify(result))
")"
echo "$GENERAL_JSON" | grep -q '"from":"bob"' || {
  echo "fallback did not recommend bob for a non-matching topic" >&2
  exit 1
}

log "recommend: transitive discovery (ada -> carol -> bob -> erin)"
TRANS_JSON="$(node --input-type=module -e "
  import { loadOrCreateIdentity } from '$ROOT/lib/identity.js'
  import { requestRecommendation } from '$ROOT/lib/peer-client.js'
  import { verifyFriendCard } from '$ROOT/lib/card.js'
  const identity = loadOrCreateIdentity('$SMOKE_DIR/keys', 'ada')
  const result = await requestRecommendation(
    { name: 'carol', host: '127.0.0.1', port: 3879, publicKey: '$CAROL_PUB' },
    { callerName: 'ada', identity, maxHops: 1 },
    'kubernetes',
  )
  const v = verifyFriendCard(result.card)
  if (!v.ok) throw new Error('transitive card invalid: ' + v.reason)
  console.log(JSON.stringify({ from: result.from, via: result.via ?? [], name: v.peer.name }))
")"
echo "transitive: $TRANS_JSON"
echo "$TRANS_JSON" | grep -q '"from":"erin"' || {
  echo "transitive discovery did not reach erin" >&2
  exit 1
}
echo "$TRANS_JSON" | grep -q '"via":\["carol","bob"\]' || {
  echo "transitive via chain is wrong: $TRANS_JSON" >&2
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

# 8. Full model-driven loop: Ada lists peers, asks carol for a recommendation,
#    asks bob+carol to cross-validate, and summarizes. Ada is a one-shot
#    headless process, so her ask server (with the pending recommendation) is
#    only alive while the task runs — the pending/decision checks below run
#    concurrently with the background task.
log "e2e: ada's headless task (peers_list -> recommend_peer -> ask_peers -> answers)"
DSH_HOME="$DSH_HOME" \
  DEEPSEEK_API_KEY=mock-key \
  DEEPSEEK_BASE_URL=http://127.0.0.1:9001/v1 \
  MOCK_RECOMMEND_PEER=carol \
  MOCK_RECOMMEND_TOPIC=env-setup \
  pnpm exec dsh --profile ada "How do I stand up the dev environment?" > "$SMOKE_DIR/ada-e2e.out" 2>&1 &
E2E_PID=$!
PIDS+=("$E2E_PID")

log "e2e: waiting for ada's ask server + pending recommendation"
ADA_UP=false
PENDING_JSON=""
for _ in $(seq 1 80); do
  if [ "$ADA_UP" != true ]; then
    R="$(curl -s -m 1 "http://127.0.0.1:3877/health" 2>/dev/null || true)"
    if echo "$R" | grep -q '"peer": *"ada"'; then
      ADA_UP=true
    fi
  fi
  PENDING_JSON="$(curl -sf http://127.0.0.1:3877/recommend/pending 2>/dev/null || true)"
  if echo "$PENDING_JSON" | grep -q '"from":"carol"'; then
    break
  fi
  sleep 0.5
done
if [ "$ADA_UP" != true ]; then
  echo "ada's ask server did not come up; task output:" >&2
  tail -n 20 "$SMOKE_DIR/ada-e2e.out" >&2
  exit 1
fi

# 9. The recommendation Ada's agent surfaced is pending; the owner's decision
#    merges the recommended peer into the friend list.
log "recommend: ada's pending list holds carol's recommendation of bob"
echo "$PENDING_JSON" | grep -q '"from":"carol"' || { echo "pending recommendation missing from carol" >&2; exit 1; }
echo "$PENDING_JSON" | grep -q '"name":"bob"' || { echo "pending recommendation missing peer bob" >&2; exit 1; }

log "recommend: an invalid decision token must be rejected"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3877/friend/decision \
  -H 'content-type: application/json' \
  -d '{"recId":"nope","token":"nope","decision":"add"}')"
[ "$code" = "403" ] || { echo "expected 403 for invalid friend decision token, got $code" >&2; exit 1; }

log "recommend: the owner's add decision merges the recommended peer"
REC_ID="$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write(d[0].recId)" "$PENDING_JSON")"
REC_TOKEN="$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write(d[0].decisionToken)" "$PENDING_JSON")"
curl -sf -X POST http://127.0.0.1:3877/friend/decision \
  -H 'content-type: application/json' \
  -d "{\"recId\":\"$REC_ID\",\"token\":\"$REC_TOKEN\",\"decision\":\"add\"}" | grep -q '"ok":true' || {
  echo "friend decision add failed" >&2
  exit 1
}
curl -sf http://127.0.0.1:3877/recommend/pending | grep -q '\[\]' || {
  echo "pending list not cleared after decision" >&2
  exit 1
}

log "e2e: ada's task output"
wait "$E2E_PID"
OUT="$(cat "$SMOKE_DIR/ada-e2e.out")"
printf '%s\n' "$OUT"
for needle in 'env-setup' 'make dev' 'docker compose' 'recommended bob'; do
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
