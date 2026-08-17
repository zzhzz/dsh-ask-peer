# Frontend design — dsh-ask-peer

This is the design for the human-facing layer: agent identity and friendship
by "sign", ask requests as chat bubbles with per-request approval, and the
friends/settings surface. The identity foundation is implemented and verified;
the Web client plugin is the next build phase.

## 1. Identity and friendship (implemented on the host side)

Every agent owns one Ed25519 signing keypair:

- Generated on first run and persisted under `keyDir`
  (default `~/.dsh-ask-peer/keys/<callerName>.key` / `.pub`). The private key
  is written with `0600` and never leaves the machine.
- The **sign** is the public key in `ed25519:<base64url>` form — the string a
  developer shares with colleagues.
- Every advertisement and every ask request is signed with the private key;
  the receiving side verifies against the stored friend sign. A forged key or
  tampered payload is rejected (the smoke test proves an impostor gets 403,
  and unsigned/mismatched adverts are refused).

Friendship is configured by pasting a friend's sign into the peer entry:

```yaml
peers:
  - name: 'bob'
    host: '192.168.1.23'
    port: 3877
    publicKey: 'ed25519:9f3b…'   # trust root; the shared token becomes optional
```

Key rotation = re-paste the new sign. Revocation = remove the entry. The UI
will surface this as a settings panel: "my sign" (with copy button), "add
friend" (name + address + sign), and a per-friend auto-answer toggle.

## 2. Approval flow (host side, phase B)

An inbound ask passes three gates before an answering agent runs:

1. allowlist + signature verification (done);
2. per-friend policy: `ask` (prompt the owner), `auto` (trusted friend, run
   immediately), `deny` — implemented, smoke-verified;
3. the answering agent's read-only sandbox and approval gate (done).

In `ask` mode the request is held, the owner is asked (name, question, context
files), and the run resumes only on approval. Implemented through dsh's
existing user-questions UI (`ctx.userQuestions.ask`), with a bounded wait
(`approvalTimeoutMs`) and fail-closed behavior when no answerer is available;
the smoke test verifies `deny` → 403 and `ask`-without-answerer → 403. The
final version is the chat bubble below.

## 3. Web client plugin (phase C)

The browser half follows dsh's client-plugin contract: a package with a
`dsh.client` manifest (`platform: 'web'`), a `./client` browser entry built
with the client tsdown preset, and a row inserted by the bundle patch so the
web app's modules node loads it into the browser roster.

**Ask bubbles.** A `ConversationNodeDefinition` of kind `ask` renders a keyed
chat node:

- **pending** — "Bob's agent asks: <question> (+ context files)" with
  Approve / Decline actions and a "always allow Bob" checkbox;
- **running** — informational while the answering agent works;
- **answered** — the answer as a reply bubble;
- **declined / failed** — terminal states.

The definition folds a replayable event family (`ask/request`, `ask/decision`,
`ask/result`, each carrying the same `askId`) into the node state, so history
scroll-back, pagination, and live append all work with the stock conversation
engine. The approve/decline action calls back into the host over the existing
client→host RPC seam, which resumes or rejects the held ask.

Implemented: the event family lives in `src/events.ts`; the host emits it into
the latest live root session and waits on the one-time-token decision endpoint
(`POST /ask/decision`, CORS-enabled); the browser half (`src/client/`) folds
the events into a `ConversationNodeDefinition` and renders the bubble. `pnpm
web-check` verifies a real dsh web profile discovers and serves the bundle;
visual verification in a real browser is the remaining step.

**Session-level answers.** An ask answers from the context of the engineer's
session, not an empty agent: the answering side copies the recent conversation
of the targeted session (`AskRequest.sessionId`, or the latest session) into
the answering agent's prompt. The live session is never touched, so the
engineer's current flow is never interrupted; advertisements list the agent's
sessions so askers can target the right context, and answering agents have ask
tools removed to prevent ask loops.

**Backlogged delivery (implemented).** `ask_peer_async` queues an ask and
returns an `askId`; the answer runs in the background (gated by the per-friend
approval mode) and is collected with `ask_result`, which blocks until
answered/failed/declined. The server keeps a TTL'd result store exposed via
`GET /ask/status?askId=`. Combined with session-level answers, a busy engineer
is never interrupted: their session is only read, and their ask queue fills in
the background.

**Friends and settings (implemented).** The plugin registers an "Ask Peer"
page into the `settings.section` slot: it shows the agent's public sign with a
copy button (the private key never leaves the disk), edits the advertised
description/tags, and manages the friend list (add by sign, per-friend mode,
remove). One platform constraint shaped the data path: dsh rc.6 serves only
allowlisted settings namespaces to the web API (`exposedNamespaces()`, "a
future registration does not become remotely readable or writable by
default"), so a plugin namespace is invisible to `settings.describe`. The
plugin therefore owns its settings: a same-origin config route
(`/ask-peer/config`, registered on the web server once it is live) hands the
browser the ask-server URL, identity, and a write token; `GET|POST /settings`
on the ask server (CORS + token) reads and persists the section to
`<keyDir>/settings-<callerName>.json`, and the host applies changes to the
peer registry live. `pnpm web-check` verifies the bundle, the config route,
and the slot; `pnpm smoke` verifies the settings endpoints (expose, wrong
token → 403, token round-trip). Visual verification remains a browser step.

**Friends and settings.** A settings row (registered into the settings slot)
shows the agent's own sign, lists friends with their verified signs and
per-friend mode, and adds/removes friends by pasting a sign.

## 4. Host ↔ client data flow

```
peer POST /ask ──> host: verify sign + allowlist
                    │  policy ask
                    ▼
              hold request, emit ask/request
                    │
              browser: bubble pending
                    │  user approves (RPC)
                    ▼
              host: run answering agent (read-only sandbox)
                    │  emit ask/result
                    ▼
              browser: answered bubble ──> peer receives answer
```

`auto` mode skips the hold; the bubble is informational (requested → answered).
Emission into the session log keeps everything replayable and gives the
conversation engine pagination for free.

## 5. Build order

| Phase | Work | Status |
|---|---|---|
| A | Identity: keygen, signed adverts/asks, verification, impostor rejection | done, smoke-verified |
| B | Approval hook with `ask` / `auto` / `deny` (interim via existing approval UI) | done, smoke-verified |
| C | Client plugin: ask bubble (conversation node + decision endpoint) | done: built, discovered, and served (visual check pending) |
| C2 | Friends/settings panel: my sign (copy), add friend by sign, per-friend mode | done: built + served (visual check pending) |
| D | mDNS discovery, reputation, multi-hop, optional payload encryption | later |

## Open decisions

- **Bubble vs. existing approval modal.** Recommendation: reuse the modal in
  phase B, ship the custom bubble in phase C (matches the vision and is more
  work).
- **Event channel.** Recommendation: emit ask events into the session log
  (replayable, paginated by the engine) rather than a bespoke push channel.
- **Confidentiality.** Signing proves authenticity; encrypting question and
  answer payloads (X25519 sealed box per friend) can be added later for
  untrusted networks.
