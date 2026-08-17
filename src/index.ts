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

/** Lightweight topics from a session title: cleaned keywords, deduped, capped. */
function topicsOf(title: string): string[] {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !TOPIC_STOPWORDS.has(word))
  return [...new Set(words)].slice(0, 5)
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
  })
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
  }
  applySettings(stored.settings)

  registerAskTools(ctx, registry, config, identity)
  startRosterRefresh(ctx, registry, config)

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
            const titles = (advert?.sessions ?? [])
              .map((s) => s.title)
              .filter((t): t is string => t !== undefined && t !== '')
            const sessions = titles.length > 0 ? ` — sessions: ${titles.join(' | ')}` : ''
            return `- ${entry.peer.name}${reachable}${tags}${description ? `: ${description}` : ''}${sessions}`
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
      const dispose = startAskServer(ctx, config, identity, () => live, {
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
            const last = session.events.at(-1)
            return {
              id: String(session.id),
              workspace: session.header.cwd !== undefined ? basename(session.header.cwd) : '',
              createdAt: session.header.createdAt,
              ...(title !== undefined ? { title } : {}),
              ...(title !== undefined ? { topics: topicsOf(title) } : {}),
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
            serverUrl: serverBaseUrl(config),
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
          res.end(JSON.stringify(listPendingAsks(config)))
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
