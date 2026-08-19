import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Config, PeerConfig } from './config.ts'
import { verifyFriendCard } from './card.ts'
import type { FriendRecommendDecisionData, FriendRecommendRequestData } from './events.ts'
import { FRIEND_DECISION_PATH, serverBaseUrlFrom, type PendingRecommendView } from './protocol.ts'

/**
 * Host-side friend recommendations: one peer forwards another agent's signed
 * friend card, the owner reviews it (chat bubble + toast), and — on "add" —
 * the peer is merged into the friend list and persisted.
 */

const RECOMMEND_TTL_MS = 10 * 60 * 1000

/** One recommendation waiting for the owner's add/decline decision. */
interface PendingRecommendation {
  recId: string
  token: string
  from: string
  card: string
  peer: PendingRecommendView['peer']
  reason?: string
  via?: string[]
  /** The session the request event was appended to, for the decision event. */
  session?: { append: (type: string, data: unknown) => void }
  createdAt: number
}

const pendingRecommendations = new Map<string, PendingRecommendation>()

function decisionUrl(config: Config): string {
  return `${serverBaseUrlFrom(config.listenHost, config.listenPort)}${FRIEND_DECISION_PATH}`
}

/**
 * Register a verified recommendation and surface it to the owner. The card is
 * verified against its own signature here; the decision endpoint re-verifies
 * before merging.
 * @returns the recommendation id and the recommended peer's display fields.
 */
export function registerRecommendation(
  ctx: Context,
  config: Config,
  from: string,
  card: string,
  reason?: string,
  via?: string[],
): { recId: string; peer: PendingRecommendView['peer'] } | { error: string } {
  const verified = verifyFriendCard(card)
  if (!verified.ok) return { error: `recommended card is invalid: ${verified.reason}` }
  const recId = randomUUID()
  const peer: PendingRecommendView['peer'] = {
    name: verified.peer.name,
    host: verified.peer.host,
    port: verified.peer.port,
    publicKey: verified.peer.publicKey,
    ...(verified.peer.description !== undefined ? { description: verified.peer.description } : {}),
    ...(verified.payload.tags !== undefined ? { tags: verified.payload.tags } : {}),
  }

  const root = ctx.get('agents')?.roots().at(-1)
  const session = root?.session
  const pending: PendingRecommendation = {
    recId,
    token: randomUUID(),
    from,
    card,
    peer,
    ...(reason !== undefined && reason !== '' ? { reason } : {}),
    ...(via !== undefined && via.length > 0 ? { via: [...via] } : {}),
    ...(session !== undefined
      ? {
          session: {
            append: (type: string, data: unknown) =>
              session.append(
                type as 'friend/recommend' | 'friend/decision',
                data as FriendRecommendRequestData | FriendRecommendDecisionData,
              ),
          },
        }
      : {}),
    createdAt: Date.now(),
  }
  pendingRecommendations.set(recId, pending)
  purgeExpired()

  if (session !== undefined) {
    const event: FriendRecommendRequestData = {
      recId,
      from,
      peer,
      ...(reason !== undefined && reason !== '' ? { reason } : {}),
      ...(via !== undefined && via.length > 0 ? { via: [...via] } : {}),
      decisionToken: pending.token,
      decisionUrl: decisionUrl(config),
    }
    try {
      session.append('friend/recommend', event)
    } catch (error) {
      ctx.logger.warn(`[ask-peer] cannot emit friend/recommend: ${String(error)}`)
    }
  }
  return { recId, peer }
}

/** The recommendations currently waiting for a decision (web notification view). */
export function listPendingRecommendations(config: Config): PendingRecommendView[] {
  purgeExpired()
  const base = decisionUrl(config)
  return [...pendingRecommendations.entries()].map(([recId, pending]) => ({
    recId,
    from: pending.from,
    peer: pending.peer,
    ...(pending.reason !== undefined ? { reason: pending.reason } : {}),
    ...(pending.via !== undefined && pending.via.length > 0 ? { via: [...pending.via] } : {}),
    decisionUrl: base,
    decisionToken: pending.token,
  }))
}

/**
 * Resolve a pending recommendation with its one-time token.
 * @returns the pending recommendation, or undefined when the token is invalid.
 */
export function resolveRecommendation(
  recId: string,
  token: string,
): PendingRecommendation | undefined {
  const pending = pendingRecommendations.get(recId)
  if (pending === undefined || pending.token !== token) return undefined
  pendingRecommendations.delete(recId)
  return pending
}

/** Emit the terminal `friend/decision` event on the recommendation's session. */
export function emitRecommendationDecision(
  pending: NonNullable<ReturnType<typeof resolveRecommendation>>,
  decision: 'added' | 'declined',
): void {
  const event: FriendRecommendDecisionData = {
    recId: pending.recId,
    from: pending.from,
    decision,
  }
  pending.session?.append('friend/decision', event)
}

/** Merge a card-derived peer into the friend list, replacing by name. */
export function mergePeer(peers: readonly PeerConfig[], peer: PeerConfig): PeerConfig[] {
  const next = peers.filter((item) => item.name !== peer.name)
  next.push(peer)
  return next
}

function purgeExpired(): void {
  const now = Date.now()
  for (const [recId, pending] of pendingRecommendations) {
    if (now - pending.createdAt > RECOMMEND_TTL_MS) pendingRecommendations.delete(recId)
  }
}
