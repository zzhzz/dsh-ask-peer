# dsh-ask-peer

A **decentralized** "ask a colleague's agent" plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

The core design is peer-to-peer: **no broker, no shared database, no company
server**. Every agent runs its own endpoint and keeps its own copy of the
relationships, so asking happens directly between two agents over the LAN.
Unlike central-server integrations (e.g. a Feishu/Slack bot), there is
nothing in the middle to operate or trust — one agent just asks another and
gets a committed answer from the colleague's own workspace and session
context.

## Features

- **Truly decentralized** — no hub, broker, or shared database; agents talk
  directly over the LAN and each side keeps its own copy of the
  relationships.
- `ask_peer` / `ask_peers` tools — ask one colleague, or 2–3 in parallel and
  cross-validate the answers.
- `recommend_peer` — discover new friends: a colleague recommends another
  agent's signed card, shown to you as a notification/chat bubble with
  Add/Decline; accepting merges them into your friend list.
- Live roster with tags — `peers_list` shows who knows what, so the model
  picks the right peer instead of guessing.
- Session-level answers — a fresh, read-only agent answers from a copy of the
  targeted session's context; your live sessions are never touched.
- Approval bubbles in the Web UI — answer or decline, or trust a friend with
  `auto` mode.
- Backlogged asks (`ask_peer_async` / `ask_result`) — no interruption of the
  answerer's current work.
- Signed friend cards — paste one signed blob to add a friend; no manual
  host/port/key copying.
- Natural invocation — the agent calls `ask_peer` / `recommend_peer` on its
  own when your request matches a friend's advertised expertise; you don't
  have to name the tool.

## Requirements

- dsh `0.1.0-rc.6` (developer-preview line this plugin is verified against)
- Node.js `^22.19.0 || >=24.0.0`, pnpm `>=10`

## Install

```sh
# local checkout (development)
dsh plugin --profile web add /path/to/dsh-ask-peer

# git install — pin a commit
dsh plugin --profile web add github:zzhzz/dsh-ask-peer#<sha>

# npm / tarball (prebuilt)
dsh plugin --profile web add dsh-ask-peer
dsh plugin --profile web add ./dsh-ask-peer-0.1.0.tgz
```

For a git install, pnpm fetches sources and runs the package's `prepare`
script to build them; pnpm >=10 requires you to allow the build first. Copy
the package key pnpm prints into the profile's `pnpm-workspace.yaml` and
re-run the `add`:

```yaml
allowBuilds:
  dsh-ask-peer: true
```

## Quick start

Only three bootstrap settings are required in the profile's
`cordis.patch.yml`; everything else is editable from the Web UI
(Settings → **Ask Peer**) and persisted to the plugin's own settings file:

```yaml
- id: ask-peer
  config:
    callerName: 'ada'
    keyDir: '/home/ada/.dsh-ask-peer/keys'
    listen: true
```

Then start the profile (`dsh --profile web`), open **Settings → Ask Peer**,
and:

1. Copy your **sign** (public key) or **friend card** and send it to a
   colleague running the same plugin.
2. Paste their card under **Add friend from a card**.
3. Set each friend's policy: `ask` (default, you approve), `auto`, or `deny`.
4. Ask in any session, e.g.:

   > Use `ask_peer` to ask Bob's agent how to set up the local dev
   > environment, with `contextFiles: ['docker-compose.yml', 'Makefile']`.

You usually don't need to be that explicit: when your question matches a
friend's advertised tags, or you mention a colleague's work, the agent asks
on its own (`peers_list` → `ask_peer` / `ask_peers`), and uses
`recommend_peer` to discover a new friend when no current friend matches.

## Configuration

The most important keys (full schema in `src/config.ts`):

| Key | Default | Meaning |
|---|---|---|
| `callerName` | `'local'` | Your identity; peers allowlist this name. |
| `keyDir` | `~/.dsh-ask-peer/keys` | Where your signing keys live. |
| `listen` / `listenHost` / `listenPort` | `false` / `127.0.0.1` / `3877` | Inbound ask server. |
| `peers` | `[]` | Friends (name, host, port, token/sign, mode). |
| `requireToken` | `true` | Require a shared token (or friend sign) on inbound asks. |
| `timeoutMs` | `120000` | How long to wait for a peer's answer. |
| `approvalTimeoutMs` | `120000` | How long to wait for your approval of an inbound ask. |
| `allowExecution` | `false` | Future execute-mode hook (not wired yet). |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full configuration
table, wire protocol, security model, and roadmap.

## Security

- Binds to `127.0.0.1` by default; only listen on the LAN if you trust it.
- Inbound callers are allowlisted and must present the shared token or a
  signature from a stored friend sign (impostors get 403).
- Answering agents run under the harness **read-only sandbox** — writes are
  denied by the sandbox itself, and permission requests are auto-rejected.
- Each ask runs in a fresh, short-lived agent that never touches your
  interactive sessions.

## Development

```sh
pnpm install
pnpm run build     # host plugin (lib/) + browser bundle (lib/client.js)
pnpm smoke         # keyless 3-instance smoke test
pnpm web-check     # verifies the web bundle is discovered and served
```

With a real DeepSeek key, the browser-level test scripts boot three instances
(Ada/Bob/Carol) and leave them running for manual checks:

```sh
bash scripts/real-choice-test.sh     # advertisement quality + peer choice
bash scripts/real-recommend-test.sh  # friend recommendation flow (add via card)
```

## Publishing

When pushing to GitHub, add the **`dsh-plugin`** topic to the repository for
ecosystem discoverability (About → Topics, or `gh repo edit <owner>/<repo>
--add-topic dsh-plugin`), plus functional topics such as `deepseek-harness`,
`dsh`, `p2p`, `peer-to-peer`, `decentralized`, `agent-collaboration`, `lan`.
For npm, `pnpm publish` — the `prepare` script builds `lib/` before
`pack`/`publish`.

## License

[MIT](./LICENSE)
