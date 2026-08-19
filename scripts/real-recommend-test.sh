#!/usr/bin/env bash
#
# Real three-agent RECOMMENDATION test with your stored DeepSeek key.
#
# Friend graph (the interesting part):
#   bob   knows carol only   <- the asker; does NOT know ada yet
#   carol knows ada + bob    <- the recommender
#   ada   knows bob          <- the recommended expert (docker / env-setup)
#
# Flow:
#   1. An automated probe proves carol's /recommend matches ADA when bob asks
#      about env-setup (ada's advert carries docker/env-setup tags + the
#      seeded session's derived topics).
#   2. In bob's browser chat, his agent calls recommend_peer(carol, ...)
#      naturally; bob's UI shows "carol recommends ada" as a toast + bubble
#      with Add friend / Decline.
#   3. Clicking Add merges ada into bob's friends; bob can then ask_peer ada.
#
# Usage: bash scripts/real-recommend-test.sh
# Stop later: kill $(cat "${TMPDIR:-/tmp}/dsh-real-recommend/pids")

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL="${TMPDIR:-/tmp}/dsh-real-recommend"
KEYS="$HOME/.dsh-ask-peer/keys"
DSH_HOME="$HOME/.dsh"
PIDS=()

log() { printf '\n== %s ==\n' "$*"; }

fail() {
  echo "FAILED: $*" >&2
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  exit 1
}

log "preflight: ports must be free"
for port in 3080 3081 3082 3877 3878 3879; do
  if lsof -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
    echo "port $port is already in use — stop the other dsh instance first:" >&2
    echo "  kill \$(lsof -tiTCP:$port -sTCP:LISTEN)" >&2
    exit 1
  fi
done

ADA_PUB="$(cat "$KEYS/ada.pub")"
CAROL_PUB="$(cat "$KEYS/carol.pub")"
BOB_PUB="$(cat "$KEYS/bob.pub")"

mkdir -p "$REAL/ada-proj" "$REAL/carol-proj" "$REAL/bob-proj"
cat > "$REAL/ada-proj/docker-compose.yml" <<'EOF'
services:
  web:
    build: .
    ports: ["8080:8080"]
    environment:
      - NODE_ENV=development
  db:
    image: postgres:16
    environment:
      - POSTGRES_PASSWORD=local
EOF
cat > "$REAL/ada-proj/Dockerfile" <<'EOF'
FROM node:22
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
CMD ["node", "server.js"]
EOF

log "building the plugin"
(cd "$ROOT" && pnpm run build >/dev/null 2>&1)

for profile in web bob-web carol-web; do
  if [ ! -d "$DSH_HOME/profiles/$profile" ]; then
    log "creating profile $profile"
    DSH_HOME="$DSH_HOME" pnpm exec dsh plugin --profile "$profile" add "$ROOT"
  fi
done

# carol-web needs the web app bundle like web / bob-web.
node -e '
  const fs = require("node:fs")
  const cwPath = process.env.HOME + "/.dsh/profiles/carol-web/package.json"
  const cw = JSON.parse(fs.readFileSync(cwPath, "utf8"))
  const bundles = cw.dsh?.profile?.bundles ?? []
  if (!bundles.includes("@deepseek-ai/dsh-web-app")) {
    bundles.splice(bundles.indexOf("@deepseek-ai/dsh-base") + 1, 0, "@deepseek-ai/dsh-web-app")
  }
  cw.dsh.profile.bundles = bundles
  fs.writeFileSync(cwPath, JSON.stringify(cw, null, 2) + "\n")
'

# Profile patches are bootstrap only; the settings files below are
# authoritative for peers/description/tags. rosterRefreshMs is kept small so
# adverts (and thus recommendation matching) settle within seconds.
write_patch() {
  local profile="$1" caller="$2" port="$3" workspace="$4"
  cat > "$DSH_HOME/profiles/$profile/cordis.patch.yml" <<EOF
- id: ask-peer
  config:
    callerName: '$caller'
    keyDir: '$KEYS'
    listen: true
    listenHost: '127.0.0.1'
    listenPort: $port
    requireToken: true
    workspace: '$workspace'
    timeoutMs: 300000
    maxAnswerChars: 48000
    approvalTimeoutMs: 120000
    allowExecution: false
    description: ''
    tags: []
    rosterRefreshMs: 3000
    peers: []
EOF
}
write_patch web ada 3877 "$REAL/ada-proj"
write_patch bob-web bob 3878 "$REAL/bob-proj"
write_patch carol-web carol 3879 "$REAL/carol-proj"

# Authoritative friend graph + ada's advertisement metadata. mallory is a
# non-matching/unreachable decoy so the probe proves topic-based selection.
node -e '
  const fs = require("node:fs")
  const KEYS = process.env.KEYS
  const adaPub = fs.readFileSync(KEYS + "/ada.pub", "utf8").trim()
  const carolPub = fs.readFileSync(KEYS + "/carol.pub", "utf8").trim()
  const bobPub = fs.readFileSync(KEYS + "/bob.pub", "utf8").trim()
  const write = (name, settings) => {
    const file = KEYS + "/settings-" + name + ".json"
    let uiToken = "ui-token-" + name
    try { uiToken = JSON.parse(fs.readFileSync(file, "utf8")).uiToken } catch {}
    fs.writeFileSync(file, JSON.stringify({ settings, uiToken }, null, 2) + "\n", { mode: 0o600 })
  }
  write("ada", {
    description: "Ada: docker & environment setup expert",
    tags: ["docker", "env-setup"],
    peers: [{ name: "bob", host: "127.0.0.1", port: 3878, publicKey: bobPub, mode: "auto" }],
  })
  write("bob", {
    description: "Bob: asks around",
    tags: [],
    peers: [{ name: "carol", host: "127.0.0.1", port: 3879, publicKey: carolPub, mode: "auto" }],
  })
  write("carol", {
    description: "Carol: testing and CI expert",
    tags: ["testing", "ci"],
    peers: [
      { name: "ada", host: "127.0.0.1", port: 3877, publicKey: adaPub, mode: "auto" },
      { name: "bob", host: "127.0.0.1", port: 3878, publicKey: bobPub, mode: "auto" },
      { name: "mallory", host: "127.0.0.1", port: 1, mode: "ask" },
    ],
  })
' KEYS="$KEYS"

log "starting ada, bob, carol (web)"
DSH_HOME="$DSH_HOME" dsh web > "$REAL/ada.log" 2>&1 &
PIDS+=($!)
DSH_HOME="$DSH_HOME" dsh --profile bob-web --port 3081 > "$REAL/bob.log" 2>&1 &
PIDS+=($!)
DSH_HOME="$DSH_HOME" dsh --profile carol-web --port 3082 > "$REAL/carol.log" 2>&1 &
PIDS+=($!)
printf '%s\n' "${PIDS[@]}" > "$REAL/pids"

wait_up() {
  local port="$1"
  for _ in $(seq 1 90); do
    if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null | grep -q 200; then
      return 0
    fi
    sleep 1
  done
  return 1
}
wait_up 3080 || fail "ada web did not come up"
wait_up 3081 || fail "bob web did not come up"
wait_up 3082 || fail "carol web did not come up"

seed() {
  local port="$1" cwd="$2" text="$3"
  local created sid
  created="$(curl -s -X POST "http://127.0.0.1:$port/api/session.create" -H 'content-type: application/json' -d "{\"type\":\"client-request\",\"rpcId\":\"seed-$(date +%s%N)\",\"method\":\"session.create\",\"payload\":{\"cwd\":\"$cwd\"}}")"
  sid="$(node -e "console.log(JSON.parse(process.argv[1]).result.value.sessionId)" "$created")"
  curl -s -X POST "http://127.0.0.1:$port/api/session.prompt" -H 'content-type: application/json' \
    -d "{\"type\":\"client-request\",\"rpcId\":\"seedp-$(date +%s%N)\",\"method\":\"session.prompt\",\"payload\":{\"sessionId\":\"$sid\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"$text\"}]}}" > /dev/null
  echo "$sid"
}

log "seeding ada's real work context (real model turn)"
ADA_SID="$(seed 3080 "$REAL/ada-proj" "Docker Compose environment setup: what are the exact commands and environment variables to build and run this docker-compose service locally?")"
echo "ada session: $ADA_SID"

log "waiting for ada's session topics to appear in her advertisement"
for _ in $(seq 1 45); do
  T="$(curl -s http://127.0.0.1:3877/advertise | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const x=(j.sessions??[]).find(x=>x.id==='$ADA_SID');process.stdout.write((x?.topic||x?.topics?.join(',')||''))})")"
  if [ -n "$T" ]; then
    echo "ada session topics: $T"
    break
  fi
  sleep 2
done

log "probe: bob asks carol to recommend an env-setup expert (topic matching)"
REC=""
for _ in $(seq 1 40); do
  REC="$(node --input-type=module -e "
    import { loadOrCreateIdentity } from '$ROOT/lib/identity.js'
    import { requestRecommendation } from '$ROOT/lib/peer-client.js'
    import { verifyFriendCard } from '$ROOT/lib/card.js'
    const identity = loadOrCreateIdentity('$KEYS', 'bob')
    const peer = { name: 'carol', host: '127.0.0.1', port: 3879, publicKey: '$CAROL_PUB' }
    const { from, card } = await requestRecommendation(
      peer,
      { callerName: 'bob', identity },
      'docker-compose dev environment',
    )
    const v = verifyFriendCard(card)
    if (!v.ok) throw new Error('card invalid: ' + v.reason)
    console.log(JSON.stringify({ from, name: v.peer.name, host: v.peer.host, port: v.peer.port, description: v.peer.description ?? '' }))
  " 2>/dev/null || true)"
  if echo "$REC" | grep -q '"from":"ada"'; then
    break
  fi
  sleep 0.5
done
echo "recommended: $REC"
echo "$REC" | grep -q '"from":"ada"' || fail "expected carol to recommend ada, got: $REC"

echo
echo "================================================================"
echo "READY. Open three tabs:"
echo "  ada  -> http://127.0.0.1:3080  (the expert: docker / env-setup)"
echo "  bob  -> http://127.0.0.1:3081  (the asker — does NOT know ada yet)"
echo "  carol-> http://127.0.0.1:3082  (the recommender)"
echo
echo "1. In BOB's chat (3081), ask:"
echo
echo "   Carol, recommend another agent who can help me stand up a"
echo "   docker-compose dev environment."
echo
echo "   If the agent does not call recommend_peer by itself, say:"
echo "   Use recommend_peer to ask Carol for a recommendation about"
echo "   docker-compose setup."
echo
echo "2. Watch for the toast (bottom-right) or the chat bubble:"
echo "   'carol recommends ada' with Add friend / Decline."
echo
echo "3. Click Add friend, then in bob's chat:"
echo
echo "   ask_peer ada: how do I stand up the docker-compose service?"
echo
echo "   You should get Ada's real answer — Bob just met Ada through the"
echo "   recommendation."
echo
echo "Stop later with: kill \$(cat \"$REAL/pids\")"
echo "================================================================"
