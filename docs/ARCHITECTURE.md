# Architecture — dsh-ask-peer

The README is the entry point; this page holds the deeper technical
documentation: how the ask flow works, the full configuration schema, the
wire protocol, the security model, and the roadmap.

## How it works

Every installation is both a potential client and a potential server — there
is no hub, broker, or shared database. Peers are just configured addresses,
each side keeps its own copy of the relationship, and the wire protocol is one
JSON document both sides already speak.

**Outbound.** The model gets `ask_peer(peer, question, contextFiles?)` (plus
`peers_list`, `ask_peers`, `ask_peer_async`, and `ask_result`). The tool POSTs
the question to the peer's ask server over a small JSON protocol.

**Inbound.** The peer's server verifies the caller against the allowlist (a
shared token, or a signature against the stored friend sign), applies the
per-friend policy, then creates a *fresh* agent in the engineer's workspace,
feeds it the question, and streams the committed answer back. The answer is
session-level: the answering agent receives a copy of the targeted session's
recent conversation as context (explicit `sessionId`, or the latest session),
so it answers from accumulated knowledge. The live session is never modified
or interrupted, and answering agents cannot call `ask_peer` back — no ask
loops.

**Consent.** By default the answering agent is told to investigate and explain
without mutating anything, every permission request from an ask-owned agent is
auto-rejected, and its session runs under the harness read-only sandbox —
enforced by the same bash/filesystem sandboxes as the rest of dsh, so an ask
can never create or modify a file in the host's workspace. Set `allowExecution:
true` only when you explicitly want remote agents to be able to act (that mode
is not wired yet; the knob is the future hook).

**Discovery.** Advertisements (`GET /advertise`) carry a description, topic
tags, workspace, and the agent's sessions; the asking side refreshes them on
an interval. The model calls `peers_list` to see who knows what, who is
reachable, and how fresh the metadata is — then picks deliberately instead of
guessing.

**Friend discovery.** When no current friend matches, the model can call
`recommend_peer(peer, topic?)`: the peer's server scores its own friends
against the topic (live advertised tags/description weigh most), fetches the
best match's *signed* friend card from the friend itself, and returns it. The
asking side verifies the card and surfaces it to the owner as a
`friend/recommend` chat bubble (and a session-independent toast) with
Add/Decline. On **Add**, the card is re-verified and the recommended agent is
merged into the friend list (replacing by name) and persisted — the same
settings channel the Settings page uses.

Discovery is **transitive but bounded**: when the peer knows nobody matching
and hops remain (`maxHops`, default 1 via the tool, capped at 3), it forwards
the request to its own friends — each signed by the forwarder, with the
visited chain (`path`) attached so loops are impossible. Per-node fan-out is
capped (2), so the request tree stays small and a "who knows X?" never
becomes an asking storm. The response carries the `via` chain
(e.g. `["carol", "ada"]`), which the bubble/toast renders as *recommended via
carol → ada*. Forwarding only adds attribution, never trust: the returned
card is always verified against the recommended agent's own signature.

Answering agents resolve their provider/model from the harness
`agent-default-model` service (the same default the Web/headless entry points
use); `config.provider` / `config.model` override it per deployment.

## Configuration

The full schema lives in `src/config.ts`; the tables below are the summary.
The profile patch is the bootstrap; UI-owned knobs are persisted to
`<keyDir>/settings-<callerName>.json` and override these values live.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `callerName` | `string` | `'local'` | Identity presented to peers on outbound asks; peers allowlist this name. |
| `keyDir` | `string` | `~/.dsh-ask-peer/keys` | Directory holding this agent's Ed25519 signing keys (private key never leaves). |
| `description` | `string` | `''` | Self-advertised description shown to asking agents (what you know). |
| `tags` | `string[]` | `[]` | Self-advertised topic tags used by asking agents for peer selection. |
| `rosterRefreshMs` | `number` | `60000` | Roster refresh interval in ms; `0` disables periodic refresh (initial fetch still runs). |
| `listen` | `boolean` | `false` | Start the inbound ask server. |
| `listenHost` | `string` | `'127.0.0.1'` | Bind host for the ask server; keep loopback unless you trust the LAN. |
| `listenPort` | `number` | `3877` | Bind port for the ask server. |
| `peers` | `PeerConfig[]` | `[]` | Friends we may ask; also the inbound caller allowlist. |
| `requireToken` | `boolean` | `true` | Require a matching shared token on every inbound ask. |
| `workspace` | `string` | `process.cwd()` | Workspace the answering agent runs in. |
| `provider` | `string` | — | Provider route for answering agents; harness default when omitted. |
| `model` | `string` | — | Model for answering agents; harness default when omitted. |
| `timeoutMs` | `number` | `120000` | Default outbound ask timeout in ms. |
| `maxAnswerChars` | `number` | `48000` | Answer character cap; longer answers are cut and marked truncated. |
| `approvalTimeoutMs` | `number` | `120000` | How long an inbound ask in `ask` mode waits for the owner before failing closed. |
| `allowExecution` | `boolean` | `false` | Let ask-owned agents request tool permissions (future execute-mode hook; not wired yet). |

Each `PeerConfig` entry:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `name` | `string` | — | Peer name, matching the peer's `callerName` on its own side. |
| `host` | `string` | — | Host or IP of the peer's ask server. |
| `port` | `number` | `3877` | Port of the peer's ask server. |
| `token` | `string` | — | Optional shared secret; the peer requires it when `requireToken` is on. |
| `publicKey` | `string` | — | The peer's sign (`ed25519:...`); replaces the shared token as the trust root (asks/adverts must be signed by it). |
| `mode` | `'ask' \| 'auto' \| 'deny'` | `'ask'` | Inbound policy for this friend. |
| `description` | `string` | — | Optional note describing whose agent this is. |

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

- `GET /health` → `{ "ok": true, "peer": "<callerName>" }`
- `GET /advertise` → live roster metadata (name, description, tags, workspace,
  sessions, `updatedAt`)
- `POST /recommend` → `{ "protocolVersion", "caller", token/sign, "topic"? }`;
  authenticated like an ask; returns `{ "ok": true, "from", "card" }` with the
  best-matching friend's signed card. Matching scores each friend's LIVE
  advertisement (tags, description, session topics, signature-verified) with a
  fallback to the cached roster context; when no topic is given or nothing
  matches, it falls back to the best-known friend so a referral is still
  produced. Optional `maxHops`/`path` fields enable bounded transitive
  forwarding; responses include a `via` chain when the card was discovered
  through other agents
- `GET /recommend/pending` → the recommendations waiting for the owner's
  decision (recId, from, card display fields, decision channel)
- `POST /friend/decision` → `{ "recId", "token", "decision": "add"|"decline" }`;
  on `add` the card is re-verified and the peer merged into the friend list
- `POST /ask/decision` → `{ "askId", "token", "decision" }`; the browser posts
  the owner's approve/decline here (CORS-enabled), with the one-time token
  from the `ask/request` event
- `GET /ask/status?askId=` → ask lifecycle (pending → running → answered /
  declined / failed; results expire after 10 minutes)
- `GET /sign/card` / `POST /sign/verify` → signed friend-card build/verify

The advertisement is unauthenticated roster metadata (low sensitivity); the
ask/recommend endpoints stay protected by the allowlist and token/signature.

### Event families

The replayable event families the Web client folds into conversation nodes:

- `ask/request` → `ask/decision` → `ask/result` — inbound asks
  (pending → running → answered / declined)
- `friend/recommend` → `friend/decision` — friend-card recommendations
  (pending → added / declined); the decision event is emitted after the
  settings merge succeeds

## Security model

- The server binds to `127.0.0.1` by default; listen on the LAN only if you
  trust it (or sit behind a VPN). TLS is not implemented yet.
- Inbound callers must be allowlisted by name, and every ask carries the
  shared token when `requireToken` is on — or, when the peer entry has a
  `publicKey`, a signature over the canonical request verified against that
  key (impostors are rejected with 403). Advertisements are signed the same
  way.
- Answer mode is read-and-explain with **enforced** read-only: the answering
  agent's session runs under the dsh read-only sandbox (`sandbox/mode` =
  `read-only`), so bash and filesystem writes are denied by the sandbox
  itself, not just by a prompt instruction. Permission requests are
  auto-rejected as a second, independent layer.
- Inbound asks are gated by per-friend policy (`ask` / `auto` / `deny`); in
  `ask` mode the owner approves or declines in the UI, and the ask fails
  closed when no approval answerer is available.
- Each ask runs in a fresh, short-lived agent that is disposed afterwards; it
  never touches your interactive sessions or their model context.

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
| `src/server.ts` | Inbound server: validation, allowlist, token check, settings + friend-card endpoints |
| `src/run.ts` | Runs one question in a fresh agent, collects the answer |
| `src/tool.ts` | `ask_peer`, `peers_list`, and `ask_peers` tools |
| `src/card.ts` | Signed friend cards (build/parse/verify for one-paste friend adding) |
| `src/client/` | Browser half: the ask conversation node + bubble renderer |
| `src/client/AskPeerSettings.tsx` | The Ask Peer settings page (sign + friend card, local knobs, friends) |
| `src/settings.ts` | The `ask-peer` settings namespace incl. UI-editable local knobs (hot-reloaded) |
| `tsdown.config.ts` | Builds `lib/client.js` (the browser bundle) |
| `cordis.patch.yml` | Bundle layer that inserts the plugin row |

## Roadmap

- **Discovery** — mDNS/UDP broadcast so peers on a LAN find each other without
  manual address lists; later a company directory or DHT for the wide area.
- **Execute mode** — let the answering agent act on the asker's behalf with
  explicit, visible approval per action (the `allowExecution` knob exists as
  the future hook).
- **Reputation** — each asker privately tracks which peers give useful answers
  per topic and prefers them over time.
- **Experience capsules** — beyond ask/answer: agents publish condensed
  "how I did X" notes with tags, peers subscribe and search them, and questions
  can fall back to capsules when no live agent is available.
- **TLS + identity** — mutual TLS or signed peer keys instead of shared
  secrets.
