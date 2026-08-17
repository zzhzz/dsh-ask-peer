// Outbound ask client. (Renamed from client.ts so the browser bundle owns lib/client.js.)
import type { PeerConfig } from './config.ts'
import { canonicalJson, signPayload, type Identity } from './identity.ts'
import {
  ADVERTISE_PATH,
  ASK_PATH,
  PROTOCOL_VERSION,
  RECOMMEND_PATH,
  type RecommendRequest,
  type RecommendSuccess,
  STATUS_PATH,
  type Advert,
  type AskAccepted,
  type AskRequest,
  type AskResponse,
  type AskStatusSuccess,
} from './protocol.ts'

export interface AskCallOptions {
  callerName: string
  /** This side's identity; when present, the request is signed. */
  identity?: Identity
  contextFiles?: readonly string[]
  timeoutMs?: number
  /** Target a specific session of the peer; omitted uses its latest. */
  sessionId?: string
  signal?: AbortSignal
}

export interface AskCallResult {
  answer: string
  truncated: boolean
}

async function postAsk(
  peer: PeerConfig,
  options: AskCallOptions,
  question: string,
  asyncFlag: boolean,
): Promise<AskResponse> {
  const request: AskRequest = {
    protocolVersion: PROTOCOL_VERSION,
    caller: options.callerName,
    token: peer.token,
    question,
    contextFiles: options.contextFiles ? [...options.contextFiles] : undefined,
    timeoutMs: options.timeoutMs,
    sessionId: options.sessionId,
    async: asyncFlag || undefined,
  }
  if (options.identity) {
    const { publicKey: _publicKey, signature: _signature, ...unsigned } = request
    request.publicKey = options.identity.publicKey
    request.signature = signPayload(options.identity.privateKey, canonicalJson(unsigned))
  }

  const url = `http://${peer.host}:${peer.port}${ASK_PATH}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: options.signal,
    })
  } catch (error) {
    throw new Error(`ask_peer: cannot reach ${peer.name} (${url}): ${String(error)}`)
  }

  if (!response.ok) {
    throw new Error(`ask_peer: peer ${peer.name} rejected the ask (HTTP ${response.status})`)
  }
  try {
    return (await response.json()) as AskResponse
  } catch (error) {
    throw new Error(`ask_peer: peer ${peer.name} returned an unparseable response: ${String(error)}`)
  }
}

/** Send one question to a peer and await its answer (synchronous ask). */
export async function askPeer(
  peer: PeerConfig,
  options: AskCallOptions,
  question: string,
): Promise<AskCallResult> {
  const body = await postAsk(peer, options, question, false)
  if (!body.ok) {
    throw new Error(`ask_peer: peer ${peer.name} failed: ${body.error.message} (${body.error.code})`)
  }
  if (!('answer' in body)) {
    throw new Error(`ask_peer: peer ${peer.name} did not return an answer`)
  }
  return { answer: body.answer, truncated: body.truncated }
}

/** Queue an ask and return its askId immediately (backlogged delivery). */
export async function askPeerAsync(
  peer: PeerConfig,
  options: AskCallOptions,
  question: string,
): Promise<{ askId: string }> {
  const body = await postAsk(peer, options, question, true)
  if (!body.ok) {
    throw new Error(`ask_peer: peer ${peer.name} failed: ${body.error.message} (${body.error.code})`)
  }
  const accepted = body as AskAccepted
  if (typeof accepted.askId !== 'string') {
    throw new Error(`ask_peer: peer ${peer.name} did not acknowledge the ask`)
  }
  return { askId: accepted.askId }
}

/**
 * Poll an async ask until it is answered (or the timeout/terminal state).
 * @returns the answer when answered; otherwise the terminal status.
 */
export async function pollAsk(
  peer: PeerConfig,
  askId: string,
  timeoutMs = 300000,
  signal?: AbortSignal,
): Promise<{ status: string; answer?: string; truncated?: boolean }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) throw new Error('ask_result: aborted')
    const url = `http://${peer.host}:${peer.port}${STATUS_PATH}?askId=${encodeURIComponent(askId)}`
    let response: Response
    try {
      response = await fetch(url, { signal })
    } catch (error) {
      throw new Error(`ask_result: cannot reach ${peer.name}: ${String(error)}`)
    }
    if (!response.ok) {
      throw new Error(`ask_result: status request failed (HTTP ${response.status})`)
    }
    const body = (await response.json()) as AskStatusSuccess
    if (body.status === 'answered') {
      return { status: body.status, answer: body.answer ?? '', truncated: body.truncated ?? false }
    }
    if (body.status === 'failed') {
      throw new Error(`ask_result: ${body.error ?? 'ask failed'}`)
    }
    if (body.status === 'declined') {
      throw new Error('ask_result: the owner declined the ask')
    }
    if (Date.now() >= deadline) return { status: body.status }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
}

/** Fetch a peer's current advertisement (roster metadata) with a bounded timeout. */
export async function fetchAdvert(peer: PeerConfig, timeoutMs = 3000): Promise<Advert> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://${peer.host}:${peer.port}${ADVERTISE_PATH}`, {
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`advertisement request failed (HTTP ${response.status})`)
    }
    const advert = (await response.json()) as Advert
    if (advert.protocolVersion !== PROTOCOL_VERSION || typeof advert.name !== 'string') {
      throw new Error('peer returned an invalid advertisement')
    }
    return advert
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask a peer to recommend one of its friends (as a signed friend card) that
 * matches a topic. The returned card is issued by the recommended agent
 * itself, so it can be verified against the embedded public key.
 */
export async function requestRecommendation(
  peer: PeerConfig,
  options: AskCallOptions,
  topic?: string,
): Promise<{ from: string; card: string }> {
  const request: RecommendRequest = {
    protocolVersion: PROTOCOL_VERSION,
    caller: options.callerName,
    token: peer.token,
    ...(topic !== undefined && topic !== '' ? { topic } : {}),
  }
  if (options.identity) {
    const { publicKey: _publicKey, signature: _signature, ...unsigned } = request
    request.publicKey = options.identity.publicKey
    request.signature = signPayload(options.identity.privateKey, canonicalJson(unsigned))
  }

  const url = `http://${peer.host}:${peer.port}${RECOMMEND_PATH}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: options.signal,
    })
  } catch (error) {
    throw new Error(`recommend_peer: cannot reach ${peer.name} (${url}): ${String(error)}`)
  }
  if (!response.ok) {
    let detail = ''
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      if (body.error !== undefined && typeof body.error.message === 'string') detail = body.error.message
    } catch {
      // Non-JSON error body; fall back to the status alone.
    }
    throw new Error(
      `recommend_peer: peer ${peer.name} rejected the request (HTTP ${response.status}${detail !== '' ? `: ${detail}` : ''})`,
    )
  }
  let body: RecommendSuccess
  try {
    body = (await response.json()) as RecommendSuccess
  } catch (error) {
    throw new Error(`recommend_peer: peer ${peer.name} returned an unparseable response: ${String(error)}`)
  }
  if (!body.ok || typeof body.card !== 'string' || typeof body.from !== 'string') {
    throw new Error(`recommend_peer: peer ${peer.name} returned an invalid recommendation`)
  }
  return { from: body.from, card: body.card }
}
