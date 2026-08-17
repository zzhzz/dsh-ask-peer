import { canonicalJson, signPayload, verifyPayload, type Identity } from './identity.ts'

/**
 * Friend cards: a single signed blob that carries everything needed to add a
 * colleague as a friend (name, host, port, public sign, description, tags).
 *
 * The card is SIGNED, not encrypted: the embedded public key is public by
 * nature, and encrypting contact info would need a secret the new friend does
 * not have yet (chicken-and-egg). The signature is what makes the card
 * trustworthy — it proves the holder of the matching private key wrote it and
 * that host/port/key were not tampered with in transit.
 */

export const CARD_PREFIX = 'dsh-ask-peer-card:'
export const CARD_VERSION = 1
export const DEFAULT_CARD_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** The signed, self-describing payload embedded in a friend card. */
export interface FriendCardPayload {
  v: 1
  /** The agent's `callerName`. */
  name: string
  /** Host/IP the card holder wants to be reached at (their ask server). */
  host: string
  /** Port of their ask server. */
  port: number
  /** Their public sign (`ed25519:...`), also the key the card is signed with. */
  publicKey: string
  /** Optional self-description, pre-filled into the friend entry. */
  description?: string
  /** Optional advertised tags, shown to the adder as a preview. */
  tags?: string[]
  /** Epoch ms when the card was issued. */
  issued: number
  /** Validity window in ms from `issued`; cards older than this are rejected. */
  ttl?: number
}

/** What a card is built from on the issuing side. */
export interface FriendCardContact {
  name: string
  host: string
  port: number
  description: string
  tags: string[]
}

export interface ParsedFriendCard {
  payload: FriendCardPayload
  /** Canonical JSON of the payload WITHOUT the signature (what the sig binds). */
  canonical: string
  signature: string
  expiresAt: number
}

export type FriendCardVerify =
  | {
      ok: true
      peer: {
        name: string
        host: string
        port: number
        publicKey: string
        description?: string
      }
      payload: FriendCardPayload
    }
  | { ok: false; reason: string }

/** Build a signed friend card for this identity and contact information. */
export function buildFriendCard(
  identity: Identity,
  contact: FriendCardContact,
  now: number = Date.now(),
): string {
  const payload: FriendCardPayload = {
    v: CARD_VERSION,
    name: contact.name,
    host: contact.host,
    port: contact.port,
    publicKey: identity.publicKey,
    ...(contact.description !== '' ? { description: contact.description } : {}),
    ...(contact.tags.length > 0 ? { tags: contact.tags } : {}),
    issued: now,
    ttl: DEFAULT_CARD_TTL_MS,
  }
  const canonical = canonicalJson(payload)
  const signature = signPayload(identity.privateKey, canonical)
  const encoded = Buffer.from(JSON.stringify({ ...payload, signature }), 'utf8').toString('base64url')
  return `${CARD_PREFIX}${encoded}`
}

/** Decode a friend card without checking the signature or expiry. */
export function parseFriendCard(card: string): ParsedFriendCard {
  if (!card.startsWith(CARD_PREFIX)) throw new Error('not a dsh-ask-peer friend card')
  let doc: FriendCardPayload & { signature?: string }
  try {
    const decoded = Buffer.from(card.slice(CARD_PREFIX.length), 'base64url').toString('utf8')
    doc = JSON.parse(decoded) as FriendCardPayload & { signature?: string }
  } catch {
    throw new Error('friend card is not valid base64 JSON')
  }
  const payload = doc
  const { signature, ...unsigned } = doc
  if (
    payload.v !== CARD_VERSION ||
    typeof payload.name !== 'string' ||
    payload.name === '' ||
    typeof payload.host !== 'string' ||
    payload.host === '' ||
    typeof payload.port !== 'number' ||
    !Number.isInteger(payload.port) ||
    payload.port <= 0 ||
    payload.port >= 65536 ||
    typeof payload.publicKey !== 'string' ||
    payload.publicKey === '' ||
    typeof payload.issued !== 'number' ||
    typeof signature !== 'string'
  ) {
    throw new Error('malformed friend card')
  }
  const ttl = typeof payload.ttl === 'number' && payload.ttl > 0 ? payload.ttl : DEFAULT_CARD_TTL_MS
  return {
    payload,
    canonical: canonicalJson(unsigned),
    signature,
    expiresAt: payload.issued + ttl,
  }
}

/** Verify a friend card: format, expiry, and the signature against its own key. */
export function verifyFriendCard(card: string, now: number = Date.now()): FriendCardVerify {
  let parsed: ParsedFriendCard
  try {
    parsed = parseFriendCard(card)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (now > parsed.expiresAt) {
    return { ok: false, reason: `friend card expired on ${new Date(parsed.expiresAt).toISOString()}` }
  }
  if (!verifyPayload(parsed.payload.publicKey, parsed.canonical, parsed.signature)) {
    return { ok: false, reason: 'signature does not match the embedded public key' }
  }
  return {
    ok: true,
    payload: parsed.payload,
    peer: {
      name: parsed.payload.name,
      host: parsed.payload.host,
      port: parsed.payload.port,
      publicKey: parsed.payload.publicKey,
      ...(parsed.payload.description !== undefined ? { description: parsed.payload.description } : {}),
    },
  }
}
