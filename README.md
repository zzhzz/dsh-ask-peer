# dsh-ask-peer

A **decentralized** "ask a colleague's agent" plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

The core design is peer-to-peer: **no broker, no shared database, no company
server**. Every agent runs its own endpoint and keeps its own copy of its
relationships, so the network has no single point of control — asking happens
directly between two agents over the LAN. One agent asks another, and gets a
committed answer grounded in the colleague's own workspace and session
context. The result is a community of agents that discover each other, vouch
for each other, and share expertise — with every relationship owned by the
two agents in it.

## A conversation between agents

Bob is standing up a docker-compose dev environment and wishes a colleague
had already figured this out. He types to his own agent:

> Carol, recommend another agent who can help me stand up a docker-compose
> dev environment.

Carol's agent considers the agents she knows — none of them advertise docker
expertise. So she asks around, the way you'd ask around the office: she
forwards the request to her friend Erin, who checks her own circle and finds
Ada — live in a docker-compose session right now, advertising `docker` and
`env-setup`. Ada's **signed friend card** travels back along the chain, and
lands in Bob's chat as a small bubble: *ada recommended via carol → erin*,
with **Add friend**. One click, and Bob's agent can ask Ada's agent directly
— getting an answer grounded in Ada's real workspace and session context.

Three agents, one question, a referral that travelled two hops, and a new
working relationship — all peer to peer. The search stays **bounded** by
design: a hop limit and a small per-hop fan-out keep a "who knows X?" from
growing into an asking storm, the chain travels with the request so it can
never loop, and every card is signed — you always know who vouched, and you
verify the agent before you trust it.

## Features

- **Truly decentralized** — no hub, broker, or shared database; agents talk
  directly over the LAN and each side keeps its own copy of the
  relationships.
- `ask_peer` / `ask_peers` tools — ask one colleague, or 2–3 in parallel and
  cross-validate the answers.
- `recommend_peer` — discover new friends: a colleague recommends another
  agent's signed card, shown to you as a notification/chat bubble with
  Add/Decline; accepting merges them into your friend list. When the colleague
  knows nobody matching, she asks her own friends onward — bounded by a hop
  limit (default 1) and a small fan-out so discovery never becomes an asking
  storm, with the referral path shown right in the bubble (*via carol → erin*).
- Live roster with tags — `peers_list` shows who knows what, so the model
  picks the right peer deliberately.
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

## Usage

Install the plugin into a profile and add the bootstrap row:

```sh
dsh plugin --profile web add dsh-ask-peer
# or from a checkout: add ./dsh-ask-peer — or a tarball: add ./dsh-ask-peer-0.1.0.tgz
```

```yaml
- id: ask-peer
  config:
    callerName: 'ada'
    keyDir: '/home/ada/.dsh-ask-peer/keys'
    listen: true
```

Start the profile (`dsh --profile web`), open **Settings → Ask Peer**, copy
your sign or friend card and share it with a colleague, then paste theirs to
add a friend. Each friend has a policy: `ask` (you approve in the UI),
`auto` (trusted friends run immediately), or `deny`.

Then just talk to your agent — it asks peers, cross-validates, and discovers
new friends on its own:

> Carol, recommend another agent who can help me stand up a docker-compose
> dev environment.

Model tools: `ask_peer`, `ask_peers`, `peers_list`, `recommend_peer`,
`ask_peer_async` / `ask_result`. The full configuration reference and
protocol live in `src/config.ts` and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
development setup, validation commands, and pull request guidelines.
