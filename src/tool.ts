import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { askPeer, askPeerAsync, pollAsk, requestRecommendation } from './peer-client.ts'
import type { Config } from './config.ts'
import type { Identity } from './identity.ts'
import type { PeerRegistry } from './registry.ts'
import { verifyFriendCard } from './card.ts'

/** Register the full model-facing tool suite: ask_peer, peers_list, ask_peers, recommend_peer. */
export function registerAskTools(
  ctx: Context,
  registry: PeerRegistry,
  config: Config,
  identity: Identity,
  onRecommend?: (from: string, card: string, reason?: string) => void,
): void {
  registerAskPeer(ctx, registry, config, identity)
  registerPeersList(ctx, registry)
  registerAskPeers(ctx, registry, config, identity)
  registerAskPeerAsync(ctx, registry, config, identity)
  registerAskResult(ctx, registry)
  registerRecommendPeer(ctx, registry, config, identity, onRecommend)
}

function registerAskPeer(ctx: Context, registry: PeerRegistry, config: Config, identity: Identity): void {
  ctx.tools.register(
    defineTool({
      name: 'ask_peer',
      description:
        'Ask ONE colleague agent a question and return its committed answer. ' +
        'Call peers_list first to see your available friends and choose by their ' +
        'advertised tags/description. peer must be a configured friend name.',
      parameters: {
        peer: {
          type: 'string',
          required: true,
          description: 'Peer name from the ask-peer configuration',
        },
        question: { type: 'string', required: true, description: 'The question to ask' },
        contextFiles: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional workspace-relative paths the colleague agent should read before answering',
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional per-call timeout in ms',
        },
        sessionId: {
          type: 'string',
          description:
            "Optional session id of the peer's agent to answer from (see peers_list); omitted uses its latest session",
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            peer: { type: 'string', required: true },
            answer: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `Answer from ${value.peer}${value.truncated ? ' (truncated)' : ''}:\n\n${value.answer}`,
          },
        ],
      },
      async execute(args, exec) {
        const peer = registry.resolve(args.peer)
        if (!peer) {
          const known = registry
            .list()
            .map((entry) => entry.peer.name)
            .join(', ')
          throw new Error(
            `ask_peer: unknown peer "${args.peer}" — call peers_list to see available peers ` +
              `(friend names from your configuration, not plugin names). Known peers: ${known || 'none'}`,
          )
        }
        const result = await askPeer(
          peer,
          {
            callerName: config.callerName,
            identity,
            contextFiles: args.contextFiles,
            timeoutMs: args.timeoutMs ?? config.timeoutMs,
            sessionId: args.sessionId,
            signal: exec.signal,
          },
          args.question,
        )
        return { peer: args.peer, answer: result.answer, truncated: result.truncated }
      },
    }),
  )
}

function registerRecommendPeer(
  ctx: Context,
  registry: PeerRegistry,
  config: Config,
  identity: Identity,
  onRecommend?: (from: string, card: string, reason?: string) => void,
): void {
  ctx.tools.register(
    defineTool({
      name: 'recommend_peer',
      description:
        'Ask a colleague agent to recommend another agent who can help — use it when the user ' +
        'needs expertise no current friend advertises (a new skill, domain, or person). The ' +
        'colleague returns a signed friend card; the recommendation is shown to the user for ' +
        'approval before the new friend is added. Call peers_list first and choose a friend ' +
        'likely to know the right person.',
      parameters: {
        peer: {
          type: 'string',
          required: true,
          description: 'Peer name to ask for the recommendation (from peers_list)',
        },
        topic: {
          type: 'string',
          description:
            'Optional topic the recommended agent should know about (their tags/description are matched)',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            peer: { type: 'string', required: true },
            from: { type: 'string', required: true },
            recommended: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `${value.from} recommended ${value.recommended}. ` +
              `The recommendation is waiting for the user's approval; it will be added to friends only if the user accepts.`,
          },
        ],
      },
      async execute(args, exec) {
        const peer = registry.resolve(args.peer)
        if (!peer) {
          const known = registry.list().map((entry) => entry.peer.name).join(', ')
          throw new Error(
            `recommend_peer: unknown peer "${args.peer}" — call peers_list to see available peers. Known: ${known || 'none'}`,
          )
        }
        const { card } = await requestRecommendation(
          peer,
          { callerName: config.callerName, identity, signal: exec.signal },
          args.topic,
        )
        const verified = verifyFriendCard(card)
        if (!verified.ok) throw new Error(`recommend_peer: recommended card is invalid: ${verified.reason}`)
        onRecommend?.(args.peer, card, args.topic)
        return {
          peer: args.peer,
          from: args.peer,
          recommended: verified.peer.name,
          status: 'awaiting_user_approval',
        }
      },
    }),
  )
}

function registerPeersList(ctx: Context, registry: PeerRegistry): void {
  ctx.tools.register(
    defineTool({
      name: 'peers_list',
      description:
        'List known colleague agents with their advertised tags, descriptions, ' +
        'workspace hints, and reachability. Call this to choose which peers to ' +
        'ask with ask_peer or ask_peers.',
      parameters: {},
      output: {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              peer: { type: 'string', required: true },
              description: { type: 'string', required: true },
              topic: { type: 'string', required: true },
              tags: { type: 'array', items: { type: 'string' }, required: true },
              workspace: { type: 'string', required: true },
              reachable: { type: 'boolean', required: true },
              lastSeen: { type: 'string', required: true },
              sessions: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    workspace: { type: 'string', required: true },
                    createdAt: { type: 'number', required: true },
                    title: { type: 'string', required: true },
                    topic: { type: 'string', required: true },
                    topics: { type: 'array', items: { type: 'string' }, required: true },
                    updatedAt: { type: 'number', required: true },
                  },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value
              .map((entry) => {
                const tagList = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : ''
                const reachable = entry.reachable ? '' : ' (unreachable)'
                const description = entry.description ? `: ${entry.description}` : ''
                const workspace = entry.workspace ? ` (workspace: ${entry.workspace})` : ''
                const topic = entry.topic ? ` — working on: ${entry.topic}` : ''
                const seen = entry.lastSeen ? ` (seen ${entry.lastSeen})` : ''
                const sessions =
                  entry.sessions.length > 0
                    ? ` (${entry.sessions.length} session${entry.sessions.length === 1 ? '' : 's'}: ${entry.sessions
                        .map((s) => s.topic || s.title || s.id.slice(0, 8))
                        .join('; ')})`
                    : ''
                return `- ${entry.peer}${reachable}${tagList}${description}${workspace}${topic}${sessions}${seen}`
              })
              .join('\n'),
          },
        ],
      },
      async execute() {
        return registry.list().map((entry) => ({
          peer: entry.peer.name,
          description: entry.advert?.description ?? entry.peer.description ?? '',
          topic:
            (entry.advert?.sessions ?? []).map((s) => s.topic).find((t) => t !== undefined && t !== '') ?? '',
          tags: entry.advert?.tags ?? [],
          workspace: entry.advert?.workspace ?? '',
          reachable: entry.reachable,
          lastSeen: entry.lastSeen > 0 ? new Date(entry.lastSeen).toISOString() : '',
          sessions: (entry.advert?.sessions ?? []).map((s) => ({
            id: s.id,
            workspace: s.workspace,
            createdAt: s.createdAt,
            title: s.title ?? '',
            topic: s.topic ?? '',
            topics: s.topics ?? [],
            updatedAt: s.updatedAt ?? 0,
          })),
        }))
      },
    }),
  )
}

function registerAskPeers(ctx: Context, registry: PeerRegistry, config: Config, identity: Identity): void {
  ctx.tools.register(
    defineTool({
      name: 'ask_peers',
      description:
        'Ask several colleague agents the same question in parallel and return ' +
        'each answer, for cross-validation. Call peers_list first and choose 2-3 ' +
        'peers by their advertised tags/description; peer names must be configured friends.',
      parameters: {
        peers: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: 'Peer names to ask (2-3 recommended)',
        },
        question: { type: 'string', required: true, description: 'The question to ask' },
        contextFiles: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional workspace-relative paths the colleagues should read before answering',
        },
        timeoutMs: { type: 'number', description: 'Optional per-call timeout in ms' },
        sessionId: {
          type: 'string',
          description:
            "Optional session id of the peers' agents to answer from (see peers_list); omitted uses each peer's latest session",
        },
      },
      output: {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              peer: { type: 'string', required: true },
              answer: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
              error: { type: 'string', required: true },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value
              .map((entry) =>
                entry.error
                  ? `- ${entry.peer}: ERROR: ${entry.error}`
                  : `- ${entry.peer}: ${entry.answer}${entry.truncated ? ' (truncated)' : ''}`,
              )
              .join('\n'),
          },
        ],
      },
      async execute(args, exec) {
        const results = await Promise.allSettled(
          args.peers.map(async (name) => {
            const peer = registry.resolve(name)
            if (!peer) throw new Error(`unknown peer "${name}"`)
            return askPeer(
              peer,
              {
                callerName: config.callerName,
                identity,
                contextFiles: args.contextFiles,
                timeoutMs: args.timeoutMs ?? config.timeoutMs,
                sessionId: args.sessionId,
                signal: exec.signal,
              },
              args.question,
            )
          }),
        )
        return args.peers.map((name, index) => {
          const result = results[index]
          if (result.status === 'fulfilled') {
            return { peer: name, answer: result.value.answer, truncated: result.value.truncated, error: '' }
          }
          return { peer: name, answer: '', truncated: false, error: String(result.reason) }
        })
      },
    }),
  )
}

function registerAskPeerAsync(ctx: Context, registry: PeerRegistry, config: Config, identity: Identity): void {
  ctx.tools.register(
    defineTool({
      name: 'ask_peer_async',
      description:
        'Queue a question to ONE colleague agent and return an askId immediately; ' +
        'the answer is produced in the background (backlogged) and collected later ' +
        'with ask_result. Call peers_list first and choose by advertised ' +
        'tags/description; peer must be a configured friend name.',
      parameters: {
        peer: { type: 'string', required: true, description: 'Peer name from the ask-peer configuration' },
        question: { type: 'string', required: true, description: 'The question to ask' },
        contextFiles: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional workspace-relative paths the colleague agent should read before answering',
        },
        sessionId: {
          type: 'string',
          description:
            "Optional session id of the peer's agent to answer from (pick by title from peers_list); omitted uses its latest session",
        },
        timeoutMs: { type: 'number', description: 'Optional answering timeout in ms' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            peer: { type: 'string', required: true },
            askId: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `Queued ask to ${value.peer}: id ${value.askId} (status ${value.status}). Collect with ask_result.` },
        ],
      },
      async execute(args, exec) {
        const peer = registry.resolve(args.peer)
        if (!peer) {
          const known = registry.list().map((entry) => entry.peer.name).join(', ')
          throw new Error(
            `ask_peer_async: unknown peer "${args.peer}" — call peers_list to see available peers. Known: ${known || 'none'}`,
          )
        }
        const { askId } = await askPeerAsync(
          peer,
          {
            callerName: config.callerName,
            identity,
            contextFiles: args.contextFiles,
            sessionId: args.sessionId,
            timeoutMs: args.timeoutMs,
            signal: exec.signal,
          },
          args.question,
        )
        return { peer: args.peer, askId, status: 'queued' }
      },
    }),
  )
}

function registerAskResult(ctx: Context, registry: PeerRegistry): void {
  ctx.tools.register(
    defineTool({
      name: 'ask_result',
      description:
        'Collect the answer of a previously queued ask (ask_peer_async). Blocks until ' +
        'the answer is ready, or the ask fails/declines/times out.',
      parameters: {
        peer: { type: 'string', required: true, description: 'Peer name from the ask-peer configuration' },
        askId: { type: 'string', required: true, description: 'The askId returned by ask_peer_async' },
        timeoutMs: { type: 'number', description: 'Optional wait cap in ms' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            peer: { type: 'string', required: true },
            status: { type: 'string', required: true },
            answer: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.status === 'answered'
                ? `Answer from ${value.peer}${value.truncated ? ' (truncated)' : ''}:\n${value.answer}`
                : `Ask on ${value.peer} is still ${value.status}`,
          },
        ],
      },
      async execute(args, exec) {
        const peer = registry.resolve(args.peer)
        if (!peer) {
          throw new Error(`ask_result: unknown peer "${args.peer}"`)
        }
        const result = await pollAsk(peer, args.askId, args.timeoutMs ?? 300000, exec.signal)
        return {
          peer: args.peer,
          status: result.status,
          answer: result.answer ?? '',
          truncated: result.truncated ?? false,
        }
      },
    }),
  )
}
