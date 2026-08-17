import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: declares ctx.webServer for the same-origin config route.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Side-effect type import: declares ctx.systemPrompt for the roster section.
import type {} from '@deepseek-ai/dsh-system-prompt'
import { basename } from 'node:path'
import { Config, type Config as AskPeerConfig } from './config.ts'
import { loadOrCreateIdentity, shortSign } from './identity.ts'
import type { SessionAdvert } from './protocol.ts'
import { PeerRegistry } from './registry.ts'
import { startRosterRefresh } from './roster.ts'
import { listPendingAsks, serverBaseUrl, startAskServer, type LiveAdvert } from './server.ts'
import {
  loadSettings,
  localFromConfig,
  saveSettings,
  type AskPeerSettings,
  type StoredSettings,
} from './settings.ts'
import { registerAskTools } from './tool.ts'

const TOPIC_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'how', 'to', 'in', 'on', 'of',
  'your', 'this', 'that', 'use', 'using', 'what', 'is', 'are', 'do', 'did',
  'can', 'we', 'i', 'it', 'from', 'by', 'at', 'as', 'be', 'not', 'about',
  'session', 'agent', 'ask', 'peer', 'plugin', 'harness', 'dsh', 'setup',
  'work', 'task', 'write', 'explain', 'build', 'run', 'local', 'commands',
  'steps', 'exact', 'service', 'required', 'environment', 'variables',
  'concise', 'please', 'colleague', 'wants', 'stand', 'need', 'using',
  'verbatim', 'pick', 'best', 'matches', 'call', 'return', 'question',
])

interface SessionTextPart {
  text: string
  source: 'user' | 'assistant'
}

function textFromBlocks(blocks: readonly { type?: string; text?: string }[]): string {
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim()
}

function stripMarkup(text: string): string {
  return text.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '').trim()
}

/** The current working point: the latest genuine user message, trimmed. */
function topicOf(parts: readonly SessionTextPart[]): string {
  const lastUser = [...parts].reverse().find((part) => part.source === 'user')
  if (lastUser === undefined) return ''
  return lastUser.text.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/** Recency-weighted keywords from the recent conversation window. */
function topicsOfRecent(parts: readonly SessionTextPart[], maxParts = 10): string[] {
  const weights = new Map<string, number>()
  const recent = parts.slice(-maxParts)
  recent.forEach((part, index) => {
    const weight = part.source === 'user' ? (index === recent.length - 1 ? 3 : 2) : 1
    for (const word of part.text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 2 && !TOPIC_STOPWORDS.has(word)) {
        weights.set(word, (weights.get(word) ?? 0) + weight)
      }
    }
  })
  return [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([word]) => word)
}

export const name = 'ask-peer'
/** The tool registry and the agent factory are required at load time. */
export const inject = ['agents', 'tools']

export { Config }

export function apply(ctx: Context, config: AskPeerConfig): void {
  // Plugin-owned settings (dsh rc.6 does not expose arbitrary namespaces to
  // the web settings API): composition defaults overlaid by the settings file.
  const stored = loadSettings(config.keyDir, config.callerName, {
    description: config.description,
    tags: config.tags,
    peers: config.peers,
    local: localFromConfig(config),
  })
  // Effective runtime config: profile patch is the bootstrap, the settings
  // file (editable from the settings page) wins for every UI-owned knob.
  const runtime: AskPeerConfig = { ...config, ...stored.settings.local }
  const registry = new PeerRegistry(stored.settings.peers)
  const identity = loadOrCreateIdentity(config.keyDir, config.callerName)
  const live: LiveAdvert = {
    description: stored.settings.description,
    tags: stored.settings.tags,
  }
  let uiToken = stored.uiToken

  const applySettings = (settings: AskPeerSettings): void => {
    live.description = settings.description
    live.tags = settings.tags
    registry.replacePeers(settings.peers)
    Object.assign(runtime, settings.local)
  }
  applySettings(stored.settings)

  registerAskTools(ctx, registry, runtime, identity)
  startRosterRefresh(ctx, registry, runtime)

  // Live roster guidance: every agent sees its available friends (name,
  // reachability, advertised tags/description) and is told to pick by them.
  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.effect(() =>
      sctx.systemPrompt.section({
        name: 'ask-peer:roster',
        order: 90,
        text: () => {
          const peers = registry.list()
          if (peers.length === 0) {
            return 'You have no ask-peer friends configured. Do not call ask_peer or ask_peers.'
          }
          const lines = peers.map((entry) => {
            const advert = entry.advert
            const tags = advert !== undefined && advert.tags.length > 0 ? ` [${advert.tags.join(', ')}]` : ''
            const description = advert !== undefined ? advert.description : (entry.peer.description ?? '')
            const reachable = entry.reachable ? '' : ' (unreachable)'
            const peerTopic =
              (advert?.sessions ?? []).map((s) => s.topic).find((t) => t !== undefined && t !== '') ?? ''
            const topic = peerTopic !== '' ? ` — working on: ${peerTopic}` : ''
            const sessionTopics = [
              ...new Set((advert?.sessions ?? []).flatMap((s) => s.topics ?? [])),
            ].slice(0, 3)
            const sessionHint =
              topic === '' && sessionTopics.length > 0 ? ` — topics: ${sessionTopics.join(', ')}` : ''
            return `- ${entry.peer.name}${reachable}${tags}${description ? `: ${description}` : ''}${topic}${sessionHint}`
          })
          return (
            'Colleague agents you can ask with ask_peer (one) or ask_peers (several), ' +
            'chosen by their advertised tags/description below (call peers_list for live details):\n' +
            lines.join('\n')
          )
        },
      }),
    )
  })

  if (config.listen) {
    ctx.effect(() => {
      const dispose = startAskServer(ctx, runtime, identity, () => live, {
        getToken: () => uiToken,
        getPeers: () => registry.list().map((entry) => entry.peer),
        getSessions: (): SessionAdvert[] => {
          const sessions = ctx.get('sessions')
          if (sessions === undefined) return []
          return sessions.list().map((session) => {
            let title: string | undefined
            for (const event of session.events) {
              if ((event.type as string) === 'session/title') {
                const data = (event as { data?: { title?: unknown } }).data
                if (data !== undefined && typeof data.title === 'string' && data.title !== '') {
                  title = data.title
                }
              }
            }
            const parts: SessionTextPart[] = []
            for (const event of session.events) {
              if (event.type === 'user/message') {
                const source = event.data.source
                if (source?.kind === 'plugin' && source.plugin === '@deepseek-ai/dsh-system-prompt') continue
                const text = textFromBlocks(event.data.content)
                if (text.length > 0) parts.push({ text, source: 'user' })
              } else if (event.type === 'assistant/message') {
                const text = stripMarkup(textFromBlocks(event.data.message.content))
                if (text.length > 0) parts.push({ text, source: 'assistant' })
              }
            }
            const topic = topicOf(parts)
            const topics = topicsOfRecent(parts)
            const last = session.events.at(-1)
            return {
              id: String(session.id),
              workspace: session.header.cwd !== undefined ? basename(session.header.cwd) : '',
              createdAt: session.header.createdAt,
              ...(title !== undefined ? { title } : {}),
              ...(topic !== '' ? { topic } : {}),
              ...(topics.length > 0 ? { topics } : {}),
              ...(last !== undefined ? { updatedAt: last.time } : {}),
            }
          })
        },
        onUpdate: (settings: AskPeerSettings) => {
          applySettings(settings)
          uiToken = uiToken
          saveSettings(config.keyDir, config.callerName, { settings, uiToken })
        },
      })
      return () => void dispose()
    })
  }

  // Same-origin config route for the browser: the settings page learns the
  // ask-server URL, its identity, and the write token without any RPC seam.
  // Registered only once the web server service is live (web profile).
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const disposeConfig = sctx.webServer.register({
        kind: 'prefix',
        path: '/ask-peer/config',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            serverUrl: serverBaseUrl(runtime),
            identity: {
              publicKey: identity.publicKey,
              fingerprint: shortSign(identity.publicKey),
            },
            uiToken,
          }))
        },
      })
      const disposePending = sctx.webServer.register({
        kind: 'prefix',
        path: '/ask-peer/pending',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(listPendingAsks(runtime)))
        },
      })
      return () => {
        disposeConfig()
        disposePending()
      }
    })
  })
}

export type { AskPeerSettings, StoredSettings }
