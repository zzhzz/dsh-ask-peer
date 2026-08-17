import type { PeerConfig } from './config.ts'
import { canonicalJson, verifyPayload } from './identity.ts'
import type { Advert } from './protocol.ts'

/** One known peer plus its live, periodically refreshed advertisement. */
export interface RosterEntry {
  peer: PeerConfig
  /** Latest fetched advertisement; absent before the first successful fetch. */
  advert?: Advert
  /** True when the last advertisement fetch succeeded. */
  reachable: boolean
  /** Epoch ms of the last successful advertisement fetch; 0 when never seen. */
  lastSeen: number
}

/**
 * Lookup table over the configured peers. This is the seam where a discovery
 * layer (mDNS broadcast, company directory) can later add peers without
 * changing the tool or the wire protocol.
 */
export class PeerRegistry {
  private readonly byName = new Map<string, RosterEntry>()

  constructor(peers: readonly PeerConfig[]) {
    for (const peer of peers) {
      this.byName.set(peer.name, { peer, reachable: false, lastSeen: 0 })
    }
  }

  list(): readonly RosterEntry[] {
    return [...this.byName.values()]
  }

  resolve(name: string): PeerConfig | undefined {
    return this.byName.get(name)?.peer
  }

  /**
   * Replace the peer set (e.g., after a settings change), preserving live
   * roster state for peers that remain.
   */
  replacePeers(peers: readonly PeerConfig[]): void {
    const next = new Map<string, RosterEntry>()
    for (const peer of peers) {
      const previous = this.byName.get(peer.name)
      next.set(
        peer.name,
        previous === undefined ? { peer, reachable: false, lastSeen: 0 } : { ...previous, peer },
      )
    }
    this.byName.clear()
    for (const [name, entry] of next) this.byName.set(name, entry)
  }

  /**
   * Record a fresh advertisement and mark the peer reachable. When the friend
   * entry carries a public key, the advertisement must be signed by it;
   * mismatched or unsigned adverts are rejected.
   * @returns true when the advertisement was accepted.
   */
  applyAdvert(name: string, advert: Advert): boolean {
    const entry = this.byName.get(name)
    if (entry === undefined) return false
    if (entry.peer.publicKey !== undefined) {
      const { publicKey, signature, ...unsigned } = advert
      if (publicKey !== entry.peer.publicKey) return false
      if (signature === undefined || !verifyPayload(entry.peer.publicKey, canonicalJson(unsigned), signature)) {
        return false
      }
    }
    entry.advert = advert
    entry.reachable = true
    entry.lastSeen = Date.now()
    return true
  }

  markUnreachable(name: string): void {
    const entry = this.byName.get(name)
    if (entry !== undefined) entry.reachable = false
  }
}
