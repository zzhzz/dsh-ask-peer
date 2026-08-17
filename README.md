# dsh-ask-peer

Peer-to-peer "ask a colleague's agent" for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

Engineers accumulate hard-won, subtle knowledge inside their agent's workspace
and context — how to stand up a dev environment, which flags actually matter,
what the tests assume. Instead of rediscovering it, one agent can *ask*
another agent directly over the network, with no central server, and get a
committed answer from the colleague's own workspace.

## Features

- **`ask_peer` / `ask_peers` tools** — the model asks one colleague, or 2–3 in
  parallel and cross-validates the answers.
- **Live roster with tags** — every side advertises a description, topic tags,
  and its active sessions; `peers_list` shows who knows what and how fresh the
  metadata is, so the asker picks deliberately instead of guessing.
- **Session-level answers** — the answering agent gets a copy of the targeted
  session's recent conversation as context, but the live session and its model
  context are never modified or interrupted.
- **Read-only answering** — ask-owned agents run under the harness read-only
  sandbox and have every permission request auto-rejected; an ask can
  investigate and explain but cannot change anything.
- **Approval bubbles (Web UI)** — inbound asks appear as a chat bubble with
  Answer / Decline buttons, or are answered automatically for trusted friends
  (`auto` mode). No loops: answering agents cannot call `ask_peer` back.
- **Backlogged asks** — `ask_peer_async` queues a question and returns an
  `askId`; the answerer produces it in the background without interrupting its
  live sessions, and `ask_result` collects it later.
- **Signed friend cards** — one signed blob (name, host, port, sign, about)
  that a colleague pastes to add you as a friend; the signature proves the
  contact info came from the holder of the matching private key.
- **Settings page** — copy your sign or friend card, edit your advertised
  description/tags, manage friends, and tune local knobs, all from
  dsh Settings → **Ask Peer**, persisted live to the plugin's own settings
  file (host/port take effect after a profile restart).

## Requirements

- DeepSeek Harness `0.1.0-rc.6` (the developer-preview line this plugin is
  verified against)
- Node.js `^22.19.0 || >=24.0.0`
- pnpm `>=10` (used by `dsh plugin` to manage profile dependencies)

## Install

Install into a dsh profile (the `web` profile in the examples). Any pnpm verb
works, so you can add from a local path, a git host, or a registry:

```sh
# local checkout (development)
dsh plugin --profile web add /path/to/dsh-ask-peer

# git install — pin a commit so a later push cannot change what runs
dsh plugin --profile web add github:zzhzz/dsh-ask-peer#<sha>

# npm / tarball (prebuilt — no build permission needed)
dsh plugin --profile web add dsh-ask-peer
dsh plugin --profile web add ./dsh-ask-peer-0.1.0.tgz
```

For a **git install**, pnpm fetches sources, not built artifacts, and runs the
package's `prepare` script to build them. pnpm >=10 refuses that script until
you allowlist the package — copy the exact package key pnpm prints into the
profile's `pnpm-workspace.yaml` and re-run the `add`:

```yaml
allowBuilds:
  dsh-ask-peer: true
```

Treat that allowance as what it is: permission to execute the package's code
at install time. Prefer the npm/tarball distribution if you do not want to
grant it.

## Quick start

Only the bootstrap settings are required in the profile's own
`cordis.patch.yml`: your identity (`callerName`, `keyDir`) and `listen: true`
to start the inbound ask server. Everything else — host, port, workspace,
timeouts, description, tags, friends, and per-friend mode — is editable from
the Web UI and stored in the plugin's settings file; the profile values are
just first-run defaults.

```yaml
- id: ask-peer
  config:
    callerName: 'ada'
    keyDir: '/home/ada/.dsh-ask-peer/keys'
    listen: true
```

Then start the profile and finish the setup in the browser:

```sh
dsh --profile web
```

1. Open **Settings → Ask Peer** and copy your **sign** (the public key — the
   private key stays on disk) or your **friend card**.
2. Send the card (or sign + host + port) to a colleague running the same
   plugin; they paste it under **Add friend from a card** — adding a friend is
   one copy-paste instead of copying host/port/sign separately.
3. Set each friend's inbound policy: `ask` (default — you approve in the UI),
   `auto` (trusted friends run immediately), or `deny`.
4. Ask. In any session, tell your agent, e.g.:

   > Use `ask_peer` to ask Bob's agent how to set up the local dev
   > environment, with `contextFiles: ['docker-compose.yml', 'Makefile']`.

The model can also call `peers_list` to choose whom to ask, `ask_peers` to
cross-validate 2–3 answers, and `ask_peer_async` / `ask_result` for backlogged
questions.

## Configuration

The full schema lives in `src/config.ts`; the table below is the summary. The
profile patch is the bootstrap; UI-owned knobs are persisted to
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

Answering agents resolve their provider/model from the harness
`agent-default-model` service (the same default the Web/headless entry points
use); `config.provider` / `config.model` override it per deployment.

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
- `POST /ask/decision` → `{ "askId", "token", "decision" }`; the browser posts
  the owner's approve/decline here (CORS-enabled), with the one-time token
  from the `ask/request` event
- `GET /ask/status?askId=` → ask lifecycle (pending → running → answered /
  declined / failed; results expire after 10 minutes)
- `GET /sign/card` / `POST /sign/verify` → signed friend-card build/verify

The advertisement is unauthenticated roster metadata (low sensitivity); the
ask endpoint itself stays protected by the allowlist and token/signature.

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

## Development

```sh
pnpm install
pnpm run build          # host plugin (lib/) + browser bundle (lib/client.js)
pnpm smoke              # keyless 3-instance host-side smoke test
pnpm web-check          # boots a real dsh web profile and verifies the bundle is served
```

The keyless smoke test boots three real dsh profiles (Ada, Bob, Carol) with a
mock model endpoint and verifies: bundle install/boot, advertisement + roster
refresh, 403s for unknown callers and wrong tokens, a direct ask through the
compiled client reaching Bob's fresh answering agent (whose attempted
workspace write is denied by the read-only sandbox), and Ada's model-driven
`peers_list` → `ask_peers` cross-validation round trip. `scripts/mock-llm.mjs`
plays the model endpoint so the round trip needs no credentials.

### Layout

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

## Publishing

This package is ready to publish as a dsh bundle: it declares the `dsh.bundle`
manifest, ships `cordis.patch.yml` + `lib/`, and its `prepare` script builds
the entry points from source so git installs work (see
[Install](#install)).

When you push the repo to GitHub:

1. Add the **`dsh-plugin`** topic to the repository — that is what the
   official ecosystem uses for discoverability (GitHub UI: repo **About →
   Topics**, or `gh repo edit <owner>/<repo> --add-topic dsh-plugin`).
2. Add functional topics too, e.g. `deepseek-harness`, `dsh`, `p2p`,
   `agent-collaboration`, `lan`, `agents`.
3. If publishing to npm, run `pnpm publish` — `prepare` also runs before
   `pnpm pack` / `pnpm publish`, so the built `lib/` is shipped — then users
   install with `dsh plugin --profile web add dsh-ask-peer`.
4. Update `package.json` `repository` / `homepage` / `bugs` if the repo URL
   differs from the placeholder.

Compatibility note: dsh is in developer preview and compatibility-breaking
changes are expected; this plugin is verified against the published
`0.1.0-rc.6` line.

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

## License

[MIT](./LICENSE)
