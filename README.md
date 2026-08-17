# dsh-ask-peer

Peer-to-peer "ask a colleague's agent" for DeepSeek Harness.

The idea: engineers accumulate hard-won, subtle knowledge inside their agent's
workspace and context (how to stand up a dev environment, which flags actually
matter, what the tests assume). Instead of each engineer rediscovering it, one
agent can *ask* another agent directly — over the network, with no central
server — and get a committed answer from the colleague's own workspace.

## How it works

Every installation of this plugin is both a potential client and a potential
server:

1. **Outbound** — the model gets an `ask_peer(peer, question, contextFiles?)`
   tool. The tool POSTs the question to the peer's ask server over a tiny JSON
   protocol.
2. **Inbound** — when the peer's server receives an ask, it verifies the caller
   against an allowlist (and an optional shared token), then creates a *fresh
   agent* in the engineer's workspace, feeds it the question, and streams the
   committed answer back. The answer is **session-level**: the answering agent
   receives a copy of the engineer's recent conversation from the targeted
   session (explicit `sessionId`, or the latest session) as context, so it
   answers from accumulated knowledge. The live session is never modified or
   interrupted, and answering agents cannot call `ask_peer` back (no ask
   loops).
3. **Consent** — by default the answering agent is told to investigate and
   explain without mutating anything, every permission request from an
   ask-owned agent is auto-rejected, and its session runs under the harness's
   **read-only sandbox** — enforced by the same bash/filesystem sandboxes as
   the rest of dsh, so an ask can never create or modify a file in the host's
   workspace. Set `allowExecution: true` only when you explicitly want remote
   agents to be able to act (that mode is not wired yet; the knob is the
   future hook).
4. **Roster** — every side advertises a description and topic tags over
   `GET /advertise`, and the asking side refreshes those advertisements on an
   interval. The model can call `peers_list` to see who knows what, who is
   reachable, and how fresh the metadata is — then pick deliberately instead
   of guessing. Advertisements also list the agent's **sessions**, so an ask
   can target a specific session's context (`ask_peer(…, sessionId)`).
5. **Cross-validation** — `ask_peers(peers, question, …)` asks 2–3 colleagues
   the same question in parallel and returns each answer, so the asker can
   compare and confirm rather than trusting one source.
6. **Ask bubbles (Web UI)** — in `ask` mode the request is emitted into your
   session log as a replayable `ask/request` event and rendered by a custom
   conversation node: a chat bubble with the caller, question, context files,
   and **Answer / Decline** buttons (plus per-friend `auto`/`deny` policies).
   The buttons post to a one-time-token decision endpoint; the answer then
   lands in the bubble as `ask/result`.
7. **Settings page (Web UI)** — the plugin registers an "Ask Peer" page in
   dsh's Settings: copy your sign (the public key — the private key stays on
   disk), edit your advertised description/tags, and manage friends (add by
   sign, per-friend `ask`/`auto`/`deny` mode, remove). Changes persist to
   `<keyDir>/settings-<callerName>.json` and apply live without a restart.
   (dsh rc.6 only exposes allowlisted namespaces to the web settings API, so
   the plugin serves its settings through its own HTTP endpoints instead.)
8. **Backlogged asks** — `ask_peer_async(peer, question, …)` queues a question
   and returns an `askId` immediately; the answerer produces the answer in the
   background (approval still applies in `ask` mode), and `ask_result(peer,
   askId)` collects it later. `GET /ask/status?askId=` exposes the lifecycle
   (pending → running → answered / declined / failed; results expire after 10
   minutes). The answerer's live sessions are never interrupted.

Answering agents resolve their provider/model from the harness's
`agent-default-model` service (the same default the Web/headless entry points
use); `config.provider` / `config.model` override it per deployment.

Decentralized by construction: there is no hub, broker, or shared database.
Peers are just configured addresses, each side keeps its own copy of the
relationship, and the protocol is one JSON document both sides already speak.

## Layout

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry: `name`, `inject`, `Config`, `apply` |
| `src/config.ts` | Schemastery config schema (peers, listen, policy) |
| `src/protocol.ts` | The JSON wire contract (`/ask`, `/health`, `/advertise`) |
| `src/registry.ts` | Peer lookup + live roster state; discovery seam |
| `src/peer-client.ts` | Outbound ask over HTTP (host half) |
| `src/events.ts` | The replayable ask event family (`ask/request` / `decision` / `result`) |
| `src/roster.ts` | Periodic advertisement refresh |
| `src/server.ts` | Inbound server: validation, allowlist, token check |
| `src/run.ts` | Runs one question in a fresh agent, collects the answer |
| `src/tool.ts` | `ask_peer`, `peers_list`, and `ask_peers` tools |
| `src/client/` | Browser half: the ask conversation node + bubble renderer |
| `src/client/AskPeerSettings.tsx` | The Ask Peer settings page (sign copy, friends) |
| `src/settings.ts` | The `ask-peer` settings namespace (hot-reloaded) |
| `tsdown.config.ts` | Builds `lib/client.js` (the browser bundle) |
| `cordis.patch.yml` | Bundle layer that inserts the plugin row |

## Install & run

Prereqs: Node `^22.19 || >=24`, pnpm, and a working dsh install
(`npx @deepseek-ai/dsh web` starts the web UI).

```sh
pnpm install
pnpm run build
dsh plugin --profile demo add /path/to/dsh-ask-peer
dsh --profile demo
```

`pnpm run build` compiles both halves: the host plugin (`lib/`) and the
browser bundle (`lib/client.js`, discovered automatically by the web app via
the package's `dsh.client` declaration).

Then override the row in your profile's `cordis.patch.yml` with your identity,
peers, and listen settings (a later layer replaces the whole `config` value, so
restate every key):

```yaml
- id: ask-peer
  config:
    callerName: 'ada'
    keyDir: '/home/ada/.dsh-ask-peer/keys'
    listen: true
    listenHost: '0.0.0.0'
    listenPort: 3877
    requireToken: true
    workspace: '/home/ada/projects/service'
    description: 'Ada: microservices and dev-environment setup'
    tags: ['env-setup', 'docker']
    rosterRefreshMs: 60000
    timeoutMs: 120000
    maxAnswerChars: 48000
    approvalTimeoutMs: 120000
    allowExecution: false
    peers:
      - name: 'bob'
        host: '192.168.1.23'
        port: 3877
        token: 'shared-secret-bob'
        publicKey: 'ed25519:9f3b…'
        mode: 'ask'
```

On the other side, Bob runs the same plugin with `callerName: 'bob'`,
`peers: [{ name: 'ada', host: ..., token: 'shared-secret-bob' }]`, and his own
`workspace`. Tokens are shared per relationship; they are matched with a
constant-time comparison on the receiving side. When a peer entry carries a
`publicKey` (the friend's sign), that key becomes the trust root instead: every
ask and advertisement must be signed by it, so a friend entry is a verified
identity rather than a shared secret. Each side generates its own Ed25519
signing keypair on first run under `keyDir`.

Alternatively, manage all of this in the Web UI: Settings → **Ask Peer**
(copy sign, edit description/tags, add/remove friends, set per-friend mode).
Those edits persist to the plugin's own settings file and apply live. The page
loads through a same-origin config route (`/ask-peer/config`) and reads/writes
`GET|POST /settings` on the ask server (token-protected); make sure `listen:
true` is set in the profile so the ask server is reachable.

Each friend has an inbound policy: `ask` (default — the owner is prompted in
the Web UI before the answering agent runs), `auto` (allowlisted friends run
immediately), or `deny`. `ask` mode waits up to `approvalTimeoutMs` and fails
closed if no answerer is available or the owner declines.

Now Ada's agent can ask, e.g.:

> Use `ask_peer` to ask Bob's agent how to set up the local dev environment,
> with `contextFiles: ['docker-compose.yml', 'Makefile']`.

## Wire protocol

`POST /ask` with:

```json
{
  "protocolVersion": 1,
  "caller": "ada",
  "token": "shared-secret-bob",
  "question": "How do I stand up the local dev environment?",
  "contextFiles": ["docker-compose.yml"]
}
```

`200`:

```json
{ "ok": true, "answer": "...", "truncated": false }
```

Errors use `{ "ok": false, "error": { "code", "message" } }` with 400/403/500.
`GET /health` returns `{ "ok": true, "peer": "<callerName>" }`.
`POST /ask/decision` accepts `{ "askId", "token", "decision" }` — the browser
posts the owner's approve/decline here (CORS-enabled); the one-time token
comes from the `ask/request` event.
`GET /advertise` returns the live roster metadata:

```json
{
  "protocolVersion": 1,
  "name": "bob",
  "description": "Bob: environment setup expert",
  "tags": ["env-setup", "docker"],
  "workspace": "service",
  "updatedAt": "2026-08-15T12:13:29.874Z"
}
```

The advertisement is unauthenticated roster metadata (low sensitivity); the
ask endpoint itself stays protected by the allowlist and token.

## Security model

- The server binds to `127.0.0.1` by default; listen on the LAN only if you
  trust it (or sit behind a VPN). TLS is not implemented yet.
- Inbound callers must be allowlisted by name, and every ask carries the shared
  token when `requireToken` is on — or, when the peer entry has a `publicKey`,
  a signature over the canonical request verified against that key (impostors
  are rejected with 403). Advertisements are signed the same way.
- Answer mode is read-and-explain with **enforced** read-only: the answering
  agent's session runs under the dsh read-only sandbox (`sandbox/mode` =
  `read-only`), so bash and filesystem writes are denied by the sandbox itself,
  not just by a prompt instruction. Permission requests are auto-rejected as a
  second, independent layer.
- Inbound asks are gated by per-friend policy (`ask` / `auto` / `deny`); in
  `ask` mode the owner approves or declines in the UI, and the ask fails
  closed when no approval answerer is available.
- Each ask runs in a fresh, short-lived agent that is disposed afterwards; it
  never touches your interactive sessions or their model context.

## Roadmap

- **Discovery** — mDNS/UDP broadcast so peers on a LAN find each other without
  manual address lists; later a company directory or DHT for the wide area.
- **Execute mode** — let the answering agent act on the asker's behalf with
  explicit, visible approval per action. This needs an opt-in switch from the
  read-only sandbox to workspace-write plus a careful approval UX
  (the `allowExecution` knob exists as the future hook).
- **Reputation** — each asker privately tracks which peers give useful answers
  per topic and prefers them over time.
- **Experience capsules** — beyond ask/answer: agents publish condensed
  "how I did X" notes with tags, peers subscribe and search them, and questions
  can fall back to capsules when no live agent is available.
- **Async asks** — queue a question, answer later, notify when the answer is
  ready (dsh already has a scheduling seam this can build on).
- **TLS + identity** — mutual TLS or signed peer keys instead of shared
  secrets.

## Smoke test

`pnpm smoke` runs the host-side suite; `pnpm web-check` boots a real dsh web
profile and verifies the browser half is discovered and served
(`/plugins/dsh-ask-peer/client.js` + the `__DSH_BOOT__` manifest entry).

The repo includes a keyless three-instance smoke test that exercises the whole
loop without an API key. It needs the dsh CLI as a dev dependency:

```sh
pnpm add -D @deepseek-ai/dsh@0.1.0-rc.6
pnpm smoke
```

The test boots three real dsh profiles (Ada, Bob, and Carol) inside
`$TMPDIR/dsh-smoke`, each with its own mock model endpoint, and verifies:

- the bundle installs into a profile and boots;
- peers advertise their tags over `/advertise` and Ada's roster refreshes;
- the inbound server rejects unknown callers and wrong tokens (403);
- a direct ask through the compiled client reaches Bob's fresh answering
  agent, whose attempted workspace write is denied by the read-only sandbox
  (no file appears);
- Ada's agent drives `peers_list` and `ask_peers` as real model tool calls,
  and her session output cross-validates answers from both Bob and Carol.

`scripts/mock-llm.mjs` plays the model endpoint: in `answerer` mode it answers
directly (optionally trying a denied workspace write first); in `asker` mode it
emits `peers_list`, then `ask_peers`, then summarizes the tool results — so the
model-driven round trip is deterministic and needs no credentials.

## Status

Verified against the published `0.1.0-rc.6` line: compiles clean, and the
keyless three-instance smoke test passes (advertisements + roster refresh,
authorization, direct client ask, read-only sandbox enforcement, and a full
model-driven `peers_list` → `ask_peers` cross-validation round trip). Still to
do before production: execute mode, discovery, TLS, and testing against the
real DeepSeek API with actual model traffic. Compatibility-breaking changes in
dsh are expected through the developer preview.

## References

- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness
- Official dev guide: `docs/user/develop/basic/` in the repo
- The ACP bridge (`packages/acp/acp`) is the in-repo template for running a
  fresh agent and collecting its committed answer.
