import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Config, PeerConfig } from './config.ts'
import type { AskDecisionData, AskRequestData, AskResultData } from './events.ts'
import { canonicalJson, shortSign, signPayload, verifyPayload, type Identity } from './identity.ts'
import {
  ADVERTISE_PATH,
  ASK_PATH,
  DECISION_PATH,
  HEALTH_PATH,
  IDENTITY_PATH,
  SETTINGS_PATH,
  STATUS_PATH,
  PROTOCOL_VERSION,
  type Advert,
  type AskStatus,
  type AskStatusSuccess,
  type PendingAskView,
  type SessionAdvert,
  errorResponse,
  type AskRequest,
  type AskResponse,
} from './protocol.ts'
import { runQuestion } from './run.ts'
import type { AskPeerSettings } from './settings.ts'

const MAX_BODY_BYTES = 1024 * 1024
const ASK_RESULT_TTL_MS = 10 * 60 * 1000

/** Live state of one async ask. */
interface AskResultEntry {
  status: AskStatus
  createdAt: number
  answer?: string
  truncated?: boolean
  error?: string
}

const askResults = new Map<string, AskResultEntry>()

/** One held ask waiting for the owner's approve/decline decision. */
interface PendingDecision {
  token: string
  caller: string
  question: string
  contextFiles?: string[]
  resolve: (decision: 'approved' | 'declined' | 'timeout') => void
}

const pendingDecisions = new Map<string, PendingDecision>()

/** The asks currently waiting for the owner's decision (for the web notification). */
export function listPendingAsks(config: Config): PendingAskView[] {
  const base = serverBaseUrl(config)
  return [...pendingDecisions.entries()].map(([askId, pending]) => ({
    askId,
    caller: pending.caller,
    question: pending.question,
    ...(pending.contextFiles !== undefined ? { contextFiles: pending.contextFiles } : {}),
    decisionUrl: `${base}${DECISION_PATH}`,
    decisionToken: pending.token,
  }))
}

export interface LiveAdvert {
  description: string
  tags: string[]
}

export interface AskServerHooks {
  /** The browser's write token for POST /settings. */
  getToken: () => string
  /** The current friend list (live registry), for auth + GET /settings. */
  getPeers: () => readonly PeerConfig[]
  /** The answering agent's sessions, for session-level advertisement. */
  getSessions: () => SessionAdvert[]
  /** Apply and persist a settings update from the browser. */
  onUpdate: (settings: AskPeerSettings) => void
}

/**
 * Start the inbound ask server. Returns a disposer that closes the listener;
 * use it as a `ctx.effect` so unloading the plugin shuts the server down.
 */
export function startAskServer(
  ctx: Context,
  config: Config,
  identity: Identity,
  live: () => LiveAdvert,
  hooks: AskServerHooks,
): () => Promise<void> {
  const server = createServer((req, res) => {
    void handleRequest(req, res, ctx, config, identity, live, hooks).catch((error: unknown) => {
      sendJson(res, 500, errorResponse('internal', error instanceof Error ? error.message : String(error)))
    })
  })

  server.listen(config.listenPort, config.listenHost)
  ctx.logger.info(`[ask-peer] inbound server listening on ${config.listenHost}:${config.listenPort}`)

  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  config: Config,
  identity: Identity,
  live: () => LiveAdvert,
  hooks: AskServerHooks,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  // Browser preflight for cross-origin calls (the Web UI is a different origin).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === HEALTH_PATH) {
    sendJson(res, 200, { ok: true, peer: config.callerName })
    return
  }

  if (req.method === 'GET' && url.pathname === ADVERTISE_PATH) {
    sendJson(res, 200, buildAdvert(config, identity, live(), hooks.getSessions()))
    return
  }

  if (req.method === 'GET' && url.pathname === IDENTITY_PATH) {
    sendJson(res, 200, {
      name: config.callerName,
      publicKey: identity.publicKey,
      fingerprint: shortSign(identity.publicKey),
      keyDir: config.keyDir,
    })
    return
  }

  if (req.method === 'GET' && url.pathname === SETTINGS_PATH) {
    sendJson(res, 200, {
      settings: {
        description: live().description,
        tags: live().tags,
        peers: hooks.getPeers(),
      },
      serverUrl: serverBaseUrl(config),
      identity: {
        publicKey: identity.publicKey,
        fingerprint: shortSign(identity.publicKey),
      },
      uiToken: hooks.getToken(),
    })
    return
  }

  if (req.method === 'POST' && url.pathname === SETTINGS_PATH) {
    await handleSettingsWrite(req, res, hooks)
    return
  }

  if (req.method === 'POST' && url.pathname === DECISION_PATH) {
    await handleDecision(req, res)
    return
  }

  if (req.method === 'GET' && url.pathname === STATUS_PATH) {
    await handleStatus(req, res)
    return
  }

  if (req.method !== 'POST' || url.pathname !== ASK_PATH) {
    sendJson(res, 404, errorResponse('not_found', `unknown path ${url.pathname}`))
    return
  }

  const raw = await readBody(req, MAX_BODY_BYTES)
  let request: AskRequest
  try {
    request = JSON.parse(raw) as AskRequest
  } catch {
    sendJson(res, 400, errorResponse('bad_request', 'request body must be JSON'))
    return
  }

  if (
    request.protocolVersion !== PROTOCOL_VERSION ||
    typeof request.caller !== 'string' ||
    typeof request.question !== 'string' ||
    request.question.trim().length === 0
  ) {
    sendJson(
      res,
      400,
      errorResponse('bad_request', 'protocolVersion, caller, and a non-empty question are required'),
    )
    return
  }

  // The live registry (settings file / Settings page), NOT the static config:
  // friend mode changes must take effect without a restart.
  const peer = hooks.getPeers().find((item) => item.name === request.caller)
  if (peer === undefined) {
    sendJson(res, 403, errorResponse('forbidden', `caller "${request.caller}" is not an allowed peer`))
    return
  }

  if (peer.publicKey !== undefined) {
    if (request.publicKey !== peer.publicKey) {
      sendJson(res, 403, errorResponse('forbidden', 'public key mismatch'))
      return
    }
    const { publicKey: _publicKey, signature, ...unsigned } = request
    if (signature === undefined || !verifyPayload(peer.publicKey, canonicalJson(unsigned), signature)) {
      sendJson(res, 403, errorResponse('forbidden', 'invalid signature'))
      return
    }
  } else if (config.requireToken || peer.token !== undefined) {
    if (!tokenMatches(peer.token ?? '', request.token)) {
      sendJson(res, 403, errorResponse('forbidden', 'invalid token'))
      return
    }
  }

  const mode = peer.mode ?? 'ask'
  if (mode === 'deny') {
    sendJson(res, 403, errorResponse('forbidden', `policy denies asks from "${request.caller}"`))
    return
  }

  if (request.async === true) {
    const askId = randomUUID()
    askResults.set(askId, { status: mode === 'ask' ? 'pending' : 'running', createdAt: Date.now() })
    purgeExpiredAsks()
    void runAsyncAsk(ctx, config, request, askId, mode).catch((error: unknown) => {
      const entry = askResults.get(askId)
      if (entry !== undefined) {
        entry.status = 'failed'
        entry.error = error instanceof Error ? error.message : String(error)
      }
    })
    sendJson(res, 202, { ok: true, askId })
    return
  }

  let approval: AskApproval = { decision: 'approved' }
  if (mode === 'ask') {
    approval = await requestApproval(ctx, config, request)
    if (approval.decision !== 'approved') {
      if (approval.decision === 'declined') emitDecision(approval, request, 'declined')
      sendJson(
        res,
        403,
        errorResponse(
          approval.decision === 'declined' ? 'declined' : 'approval_unavailable',
          approval.decision === 'declined'
            ? `the owner declined the ask from "${request.caller}"`
            : `no approval answerer is available to review the ask from "${request.caller}"`,
        ),
      )
      return
    }
    emitDecision(approval, request, 'approved')
  }

  const timeoutMs =
    request.timeoutMs !== undefined && request.timeoutMs > 0 ? request.timeoutMs : config.timeoutMs
  try {
    const outcome = await runQuestion(
      ctx,
      config,
      request.question,
      request.contextFiles,
      timeoutMs,
      request.sessionId,
    )
    emitResult(approval, request, outcome)
    const body: AskResponse = { ok: true, answer: outcome.answer, truncated: outcome.truncated }
    sendJson(res, 200, body)
  } catch (error) {
    sendJson(res, 500, errorResponse('ask_failed', error instanceof Error ? error.message : String(error)))
  }
}

function tokenMatches(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false
  const a = Buffer.from(actual, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...corsHeaders() })
  res.end(JSON.stringify(body))
}

type AskApproval =
  | { decision: 'approved'; askId?: string; session?: Session }
  | { decision: 'declined'; askId?: string; session?: Session }
  | { decision: 'unavailable' }

/**
 * Hold an inbound ask for the owner's decision. The ask is registered as a
 * pending notification (the web client polls it and shows Answer/Decline),
 * mirrored into the latest live session when one exists, and resolved through
 * the one-time-token decision endpoint. Fails closed on timeout.
 */
async function requestApproval(
  ctx: Context,
  config: Config,
  request: AskRequest,
  askId: string = randomUUID(),
): Promise<AskApproval> {
  const decisionToken = randomUUID()
  const root = ctx.get('agents')?.roots().at(-1)
  const session = root?.session
  if (session !== undefined) {
    const event: AskRequestData = {
      askId,
      caller: request.caller,
      question: request.question,
      contextFiles: request.contextFiles,
      decisionToken,
      decisionUrl: decisionUrl(config),
    }
    try {
      session.append('ask/request', event)
    } catch (error) {
      ctx.logger.warn(`[ask-peer] cannot emit ask/request: ${String(error)}`)
    }
  }

  const decided = await waitForDecision(
    askId,
    decisionToken,
    config.approvalTimeoutMs,
    request.caller,
    request.question,
    request.contextFiles,
  )
  if (decided === 'approved') return { decision: 'approved', askId, session }
  if (decided === 'declined') return { decision: 'declined', askId, session }
  return { decision: 'unavailable' }
}

function waitForDecision(
  askId: string,
  token: string,
  timeoutMs: number,
  caller: string,
  question: string,
  contextFiles: string[] | undefined,
): Promise<'approved' | 'declined' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingDecisions.delete(askId)
      resolve('timeout')
    }, timeoutMs)
    pendingDecisions.set(askId, {
      token,
      caller,
      question,
      contextFiles,
      resolve: (decision) => {
        clearTimeout(timer)
        pendingDecisions.delete(askId)
        resolve(decision)
      },
    })
  })
}

async function handleDecision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { askId?: unknown; token?: unknown; decision?: unknown }
  try {
    body = JSON.parse(await readBody(req, MAX_BODY_BYTES)) as typeof body
  } catch {
    sendJson(res, 400, errorResponse('bad_request', 'request body must be JSON'))
    return
  }
  if (typeof body.askId !== 'string' || typeof body.token !== 'string' || typeof body.decision !== 'string') {
    sendJson(res, 400, errorResponse('bad_request', 'askId, token, and decision are required'))
    return
  }
  const pending = pendingDecisions.get(body.askId)
  if (pending === undefined || pending.token !== body.token) {
    sendJson(res, 403, errorResponse('forbidden', 'invalid decision token'))
    return
  }
  if (body.decision === 'approve') {
    pending.resolve('approved')
    sendJson(res, 200, { ok: true })
    return
  }
  if (body.decision === 'decline') {
    pending.resolve('declined')
    sendJson(res, 200, { ok: true })
    return
  }
  sendJson(res, 400, errorResponse('bad_request', 'decision must be approve or decline'))
}

async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const askId = url.searchParams.get('askId')
  if (askId === null || askId === '') {
    sendJson(res, 400, errorResponse('bad_request', 'askId query parameter is required'))
    return
  }
  const entry = askResults.get(askId)
  if (entry === undefined || Date.now() - entry.createdAt > ASK_RESULT_TTL_MS) {
    askResults.delete(askId)
    sendJson(res, 404, errorResponse('not_found', `unknown or expired ask ${askId}`))
    return
  }
  const body: AskStatusSuccess = {
    ok: true,
    status: entry.status,
    ...(entry.answer !== undefined ? { answer: entry.answer } : {}),
    ...(entry.truncated !== undefined ? { truncated: entry.truncated } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  }
  sendJson(res, 200, body)
}

async function handleSettingsWrite(req: IncomingMessage, res: ServerResponse, hooks: AskServerHooks): Promise<void> {
  let body: { token?: unknown; settings?: unknown }
  try {
    body = JSON.parse(await readBody(req, MAX_BODY_BYTES)) as typeof body
  } catch {
    sendJson(res, 400, errorResponse('bad_request', 'request body must be JSON'))
    return
  }
  if (body.token !== hooks.getToken()) {
    sendJson(res, 403, errorResponse('forbidden', 'invalid settings token'))
    return
  }
  const settings = sanitizeSettings(body.settings)
  if (settings === undefined) {
    sendJson(res, 400, errorResponse('bad_request', 'settings must be an object with description, tags, and peers'))
    return
  }
  hooks.onUpdate(settings)
  sendJson(res, 200, { ok: true })
}

const FRIEND_MODES = new Set(['ask', 'auto', 'deny'])

/** Defensive parse of the browser-submitted settings section. */
function sanitizeSettings(value: unknown): AskPeerSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const description = typeof raw.description === 'string' ? raw.description : ''
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : []
  if (!Array.isArray(raw.peers)) return undefined
  const peers: PeerConfig[] = []
  for (const item of raw.peers) {
    if (typeof item !== 'object' || item === null) return undefined
    const peer = item as Record<string, unknown>
    if (typeof peer.name !== 'string' || peer.name === '' || typeof peer.host !== 'string' || peer.host === '') {
      return undefined
    }
    const mode = peer.mode === undefined ? 'ask' : peer.mode
    if (typeof mode !== 'string' || !FRIEND_MODES.has(mode)) return undefined
    peers.push({
      name: peer.name,
      host: peer.host,
      port: typeof peer.port === 'number' ? peer.port : 3877,
      ...typeof peer.token === 'string' && peer.token !== '' ? { token: peer.token } : {},
      ...typeof peer.publicKey === 'string' && peer.publicKey !== '' ? { publicKey: peer.publicKey } : {},
      mode: mode as 'ask' | 'auto' | 'deny',
      ...typeof peer.description === 'string' && peer.description !== '' ? { description: peer.description } : {},
    })
  }
  return { description, tags, peers }
}

/** Run an async ask in the background: approval (when required), then answer. */
async function runAsyncAsk(
  ctx: Context,
  config: Config,
  request: AskRequest,
  askId: string,
  mode: 'ask' | 'auto',
): Promise<void> {
  const entry = askResults.get(askId)
  if (entry === undefined) return
  const timeoutMs =
    request.timeoutMs !== undefined && request.timeoutMs > 0 ? request.timeoutMs : config.timeoutMs

  let approval: AskApproval = { decision: 'approved' }
  if (mode === 'ask') {
    entry.status = 'pending'
    approval = await requestApproval(ctx, config, request, askId)
    if (approval.decision !== 'approved') {
      if (approval.decision === 'declined') emitDecision(approval, request, 'declined')
      entry.status = approval.decision === 'declined' ? 'declined' : 'failed'
      if (approval.decision !== 'declined') entry.error = 'no approval answerer is available'
      return
    }
    emitDecision(approval, request, 'approved')
  }

  entry.status = 'running'
  try {
    const outcome = await runQuestion(ctx, config, request.question, request.contextFiles, timeoutMs, request.sessionId)
    entry.status = 'answered'
    entry.answer = outcome.answer
    entry.truncated = outcome.truncated
    emitResult(approval, request, outcome)
  } catch (error) {
    entry.status = 'failed'
    entry.error = error instanceof Error ? error.message : String(error)
  }
}

function purgeExpiredAsks(): void {
  const now = Date.now()
  for (const [askId, entry] of askResults) {
    if (now - entry.createdAt > ASK_RESULT_TTL_MS) askResults.delete(askId)
  }
}

function emitDecision(approval: AskApproval, request: AskRequest, decision: 'approved' | 'declined'): void {
  if (approval.decision === 'unavailable' || approval.session === undefined || approval.askId === undefined) return
  const event: AskDecisionData = { askId: approval.askId, caller: request.caller, decision }
  try {
    approval.session.append('ask/decision', event)
  } catch {
    // The session may have closed while the decision was pending.
  }
}

function emitResult(
  approval: AskApproval,
  request: AskRequest,
  outcome: { answer: string; truncated: boolean },
): void {
  if (approval.decision === 'unavailable' || approval.session === undefined || approval.askId === undefined) return
  const event: AskResultData = {
    askId: approval.askId,
    caller: request.caller,
    answer: outcome.answer,
    truncated: outcome.truncated,
  }
  try {
    approval.session.append('ask/result', event)
  } catch {
    // The session may have closed while the answering agent ran.
  }
}

/** The base URL of this side's inbound ask server, as a browser can reach it. */
export function serverBaseUrl(config: Config): string {
  const host =
    config.listenHost === '0.0.0.0' || config.listenHost === '::' ? '127.0.0.1' : config.listenHost
  return `http://${host}:${config.listenPort}`
}

function decisionUrl(config: Config): string {
  return `${serverBaseUrl(config)}${DECISION_PATH}`
}

/** The live metadata this side advertises to asking agents, signed by its identity. */
function buildAdvert(config: Config, identity: Identity, live: LiveAdvert, sessions: SessionAdvert[]): Advert {
  const unsigned = {
    protocolVersion: PROTOCOL_VERSION,
    name: config.callerName,
    description: live.description,
    tags: live.tags,
    workspace: basename(resolve(config.workspace)),
    updatedAt: new Date().toISOString(),
    sessions,
  }
  return {
    ...unsigned,
    publicKey: identity.publicKey,
    signature: signPayload(identity.privateKey, canonicalJson(unsigned)),
  }
}
