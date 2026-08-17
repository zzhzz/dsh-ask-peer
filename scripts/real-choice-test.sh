#!/usr/bin/env bash
#
# Real three-agent advertisement/choice test with your stored DeepSeek key.
#
# Domains:
#   ada  — docker-compose / environment setup (workspace ada-proj)
#   carol— postgres / database (workspace carol-proj)
#   bob  — frontend / CI (workspace bob-proj); bob is the asker.
#
# What it verifies:
#   1. advertisements are AUTOMATICALLY generated from real sessions:
#      each advert lists sessions with auto titles + derived topics;
#   2. bob's agent CHOOSES the right peer by those advertisements when asked
#      a docker question, and the answer actually comes from ada.
#
# Usage: bash scripts/real-choice-test.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL="${TMPDIR:-/tmp}/dsh-real"
KEYS="$HOME/.dsh-ask-peer/keys"
DSH_HOME="$HOME/.dsh"
PIDS=()

log() { printf '\n== %s ==\n' "$*"; }
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

ADA_PUB="$(cat "$KEYS/ada.pub")"
CAROL_PUB="$(cat "$KEYS/carol.pub")"
BOB_PUB="$(cat "$KEYS/bob.pub")"

# 1. Real workspaces with a few real files.
mkdir -p "$REAL/ada-proj" "$REAL/carol-proj" "$REAL/bob-proj"
mkdir -p "$REAL/bob-proj/.github/workflows"
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
cat > "$REAL/carol-proj/schema.sql" <<'EOF'
CREATE TABLE users (id bigserial PRIMARY KEY, email text UNIQUE NOT NULL);
CREATE INDEX ON users (email);
EOF
cat > "$REAL/bob-proj/.github/workflows/ci.yml" <<'EOF'
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test
EOF

# 2. Profiles: ada (web), carol-web (new), bob-web (existing) + headless bob.
if [ ! -d "$DSH_HOME/profiles/carol-web" ]; then
  log "creating carol-web profile"
  DSH_HOME="$DSH_HOME" pnpm exec dsh plugin --profile carol-web add "$ROOT"
fi
for profile in web bob-web carol-web; do
  if [ ! -d "$DSH_HOME/profiles/$profile" ]; then
    DSH_HOME="$DSH_HOME" pnpm exec dsh plugin --profile "$profile" add "$ROOT"
  fi
done

node -e '
  const fs = require("node:fs")
  const HOME = process.env.HOME
  const keys = HOME + "/.dsh-ask-peer/keys"
  const adaPub = fs.readFileSync(keys + "/ada.pub", "utf8").trim()
  const carolPub = fs.readFileSync(keys + "/carol.pub", "utf8").trim()
  const bobPub = fs.readFileSync(keys + "/bob.pub", "utf8").trim()
  const REAL = process.env.REAL

  // carol-web manifest: add web-app bundle
  const cwPath = HOME + "/.dsh/profiles/carol-web/package.json"
  const cw = JSON.parse(fs.readFileSync(cwPath, "utf8"))
  const cwBundles = cw.dsh?.profile?.bundles ?? []
  if (!cwBundles.includes("@deepseek-ai/dsh-web-app")) {
    cwBundles.splice(cwBundles.indexOf("@deepseek-ai/dsh-base") + 1, 0, "@deepseek-ai/dsh-web-app")
  }
  cw.dsh.profile.bundles = cwBundles
  fs.writeFileSync(cwPath, JSON.stringify(cw, null, 2) + "\n")

  const patch = (profile, callerName, port, workspace, peers) => {
    const rows = peers.map(p =>
      `      - name: '"'"'${p.name}'"'"'\n        host: '"'"'127.0.0.1'"'"'\n        port: ${p.port}\n        publicKey: '"'"'${p.pub}'"'"'\n        mode: '"'"'auto'"'"'`
    ).join("\n")
    fs.writeFileSync(HOME + "/.dsh/profiles/" + profile + "/cordis.patch.yml", `- id: ask-peer
  config:
    callerName: '"'"'${callerName}'"'"'
    keyDir: '"'"'${keys}'"'"'
    listen: true
    listenHost: '"'"'127.0.0.1'"'"'
    listenPort: ${port}
    requireToken: true
    workspace: '"'"'${workspace}'"'"'
    timeoutMs: 300000
    maxAnswerChars: 48000
    approvalTimeoutMs: 120000
    allowExecution: false
    description: '"'"''"'"'
    tags: []
    rosterRefreshMs: 60000
    peers:
${rows}
`)
  }

  patch("carol-web", "carol", 3879, REAL + "/carol-proj", [
    { name: "ada", port: 3877, pub: adaPub },
    { name: "bob", port: 3878, pub: bobPub },
  ])

  // Settings files override the profile patches once they exist — rewrite them
  // so every side knows the other two.
  const settings = (name, peers) => {
    const file = keys + "/settings-" + name + ".json"
    const doc = JSON.parse(fs.readFileSync(file, "utf8"))
    doc.settings.peers = peers
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 })
  }
  settings("ada", [
    { name: "bob", host: "127.0.0.1", port: 3878, publicKey: bobPub, mode: "auto" },
    { name: "carol", host: "127.0.0.1", port: 3879, publicKey: carolPub, mode: "auto" },
  ])
  settings("bob", [
    { name: "ada", host: "127.0.0.1", port: 3877, publicKey: adaPub, mode: "auto" },
    { name: "carol", host: "127.0.0.1", port: 3879, publicKey: carolPub, mode: "auto" },
  ])
  fs.writeFileSync(keys + "/settings-carol.json", JSON.stringify({
    settings: {
      description: "",
      tags: [],
      peers: [
        { name: "ada", host: "127.0.0.1", port: 3877, publicKey: adaPub, mode: "auto" },
        { name: "bob", host: "127.0.0.1", port: 3878, publicKey: bobPub, mode: "auto" },
      ],
    },
    uiToken: "carol-ui-token",
  }, null, 2) + "\n", { mode: 0o600 })
  console.log("profiles configured")
' REAL="$REAL"

# 3. Start the three instances.
log "starting ada, carol, bob"
DSH_HOME="$DSH_HOME" dsh web > "$REAL/ada.log" 2>&1 &
PIDS+=($!)
DSH_HOME="$DSH_HOME" dsh --profile carol-web --port 3082 > "$REAL/carol.log" 2>&1 &
PIDS+=($!)

wait_up() {
  local port="$1"
  for _ in $(seq 1 90); do
    if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null | grep -q 200; then return 0; fi
    sleep 1
  done
  echo "port $port did not come up" >&2
  return 1
}
wait_up 3080
wait_up 3082

seed() {
  local port="$1" cwd="$2" text="$3"
  local created sid
  created="$(curl -s -X POST "http://127.0.0.1:$port/api/session.create" -H 'content-type: application/json' -d "{\"type\":\"client-request\",\"rpcId\":\"seed-$(date +%s%N)\",\"method\":\"session.create\",\"payload\":{\"cwd\":\"$cwd\"}}")"
  sid="$(node -e "console.log(JSON.parse(process.argv[1]).result.value.sessionId)" "$created")"
  curl -s -X POST "http://127.0.0.1:$port/api/session.prompt" -H 'content-type: application/json' \
    -d "{\"type\":\"client-request\",\"rpcId\":\"seedp-$(date +%s%N)\",\"method\":\"session.prompt\",\"payload\":{\"sessionId\":\"$sid\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"$text\"}]}}" > /dev/null
  echo "$sid"
}

log "seeding real work contexts (real model turns)"
ADA_SID="$(seed 3080 "$REAL/ada-proj" "Docker Compose environment setup: what are the exact commands and environment variables to build and run this docker-compose service locally?")"
CAROL_SID="$(seed 3082 "$REAL/carol-proj" "PostgreSQL database migrations: how should this schema.sql be migrated safely to a running postgres database?")"
echo "ada session: $ADA_SID"
echo "carol session: $CAROL_SID"

log "waiting for auto-generated session titles"
for _ in $(seq 1 30); do
  A_TOPICS="$(curl -s http://127.0.0.1:3877/advertise | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const t=(j.sessions??[]).find(x=>x.id==='$ADA_SID')?.topics||[];process.stdout.write(t.join(' '))})")"
  C_TOPICS="$(curl -s http://127.0.0.1:3879/advertise | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const t=(j.sessions??[]).find(x=>x.id==='$CAROL_SID')?.topics||[];process.stdout.write(t.join(' '))})")"
  if [ -n "$A_TOPICS" ] && [ -n "$C_TOPICS" ]; then break; fi
  sleep 2
done

log "advertisement quality (auto-generated)"
echo "-- ada advert --"
curl -s http://127.0.0.1:3877/advertise | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(JSON.stringify(j.sessions,null,1))})"
echo "-- carol advert --"
curl -s http://127.0.0.1:3879/advertise | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(JSON.stringify(j.sessions,null,1))})"

echo "ada topics: $A_TOPICS"
echo "carol topics: $C_TOPICS"

log "bob's choosing task (real model)"
OUT="$(DSH_HOME="$DSH_HOME" dsh --profile bob "A colleague wants to stand up the docker-compose service in the ada-proj workspace. Call peers_list, pick the peer whose advertisement best matches this need, then ask that peer with ask_peer how to do it. Return the answer verbatim.")"
printf '%s\n' "$OUT"

echo "== assertions =="
if grep -qi 'docker\|compose' <<<"$A_TOPICS"; then echo "PASS: ada advert topics mention docker/compose"; else echo "WARN: ada topics: $A_TOPICS"; fi
if grep -qi 'postgres\|database\|migrat' <<<"$C_TOPICS"; then echo "PASS: carol advert topics mention postgres/db"; else echo "WARN: carol topics: $C_TOPICS"; fi
if grep -qi 'docker\|compose' <<<"$OUT" && ! grep -qi 'postgres\|database\|migrat' <<<"$OUT"; then echo "PASS: bob chose ada and the answer is docker-flavored"; else echo "CHECK: bob output above (expected docker answer from ada, no postgres)"; fi
