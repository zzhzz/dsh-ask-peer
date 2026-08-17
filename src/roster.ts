import type { Context } from '@deepseek-ai/cordis'
import { fetchAdvert } from './peer-client.ts'
import type { Config } from './config.ts'
import type { PeerRegistry } from './registry.ts'

/**
 * Periodically refresh each peer's advertisement so the roster the asking
 * agent sees stays current. Runs once immediately, then on the configured
 * interval; overlapping refreshes are skipped and per-peer failures only mark
 * that peer unreachable.
 */
export function startRosterRefresh(ctx: Context, registry: PeerRegistry, config: Config): void {
  let running = false
  const refresh = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await Promise.allSettled(
        registry.list().map(async (entry) => {
          try {
            const accepted = registry.applyAdvert(entry.peer.name, await fetchAdvert(entry.peer))
            if (!accepted) registry.markUnreachable(entry.peer.name)
          } catch {
            registry.markUnreachable(entry.peer.name)
          }
        }),
      )
    } finally {
      running = false
    }
  }

  void refresh()
  if (config.rosterRefreshMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => void refresh(), config.rosterRefreshMs)
      return () => clearInterval(timer)
    })
  }
}
