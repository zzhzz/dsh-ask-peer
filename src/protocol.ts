/**
 * Wire protocol for peer asks: one HTTP POST with a JSON body per question.
 * Every dsh-ask-peer instance speaks the same contract, so peers do not need
 * to share code beyond the JSON schema documented here.
 */

export const PROTOCOL_VERSION = 1
export const ASK_PATH = '/ask'
export const DECISION_PATH = '/ask/decision'
export const HEALTH_PATH = '/health'
export const ADVERTISE_PATH = '/advertise'
export const IDENTITY_PATH = '/identity'
export const SETTINGS_PATH = '/settings'
export const STATUS_PATH = '/ask/status'
export const SIGN_CARD_PATH = '/sign/card'
export const SIGN_VERIFY_PATH = '/sign/verify'

/** One of the answering agent's sessions, advertised for session-level asks. */
export interface SessionAdvert {
  /** Durable session id; pass it as AskRequest.sessionId to target this context. */
  id: string
  /** Workspace basename the session was created in. */
  workspace: string
  /** Session creation time (epoch ms). */
  createdAt: number
  /** Auto-generated session title (dsh's own titles), when available. */
  title?: string
  /** Current working point, derived from the latest conversation. */
  topic?: string
  /** Lightweight topics derived from recent conversation (not the stale title). */
  topics?: string[]
  /** Epoch ms of the latest event in the session. */
  updatedAt?: number
}

/** A pending ask surfaced to the owner as a notification. */
export interface PendingAskView {
  askId: string
  caller: string
  question: string
  contextFiles?: string[]
  decisionUrl: string
  decisionToken: string
}

/**
 * A peer's self-advertisement: the live metadata asking agents use to choose
 * whom to ask. Served unauthenticated (it is low-sensitivity roster metadata);
 * the actual ask endpoint stays protected by the allowlist and token.
 */
export interface Advert {
  protocolVersion: number
  /** The peer's `callerName`. */
  name: string
  /** Self-described expertise, shown to asking agents. */
  description: string
  /** Self-advertised topic tags used for peer selection. */
  tags: string[]
  /** Basename of the answering workspace (context hint, not the full path). */
  workspace: string
  /** ISO timestamp of this advertisement. */
  updatedAt: string
  /** The advertising agent's public sign (`ed25519:...`). */
  publicKey: string
  /** Signature over the canonical advert fields (excluding publicKey/signature). */
  signature: string
  /** The agent's sessions, so askers can target a specific context. */
  sessions: SessionAdvert[]
}

export interface AskRequest {
  protocolVersion: number
  /** Sender identity (the asking side's `callerName`). */
  caller: string
  /** Shared secret, required when the peer runs with `requireToken`. */
  token?: string
  /** Sender's public sign (`ed25519:...`), present when key-based auth is used. */
  publicKey?: string
  /** Signature over the canonical request body, base64url. */
  signature?: string
  /** The question to ask. */
  question: string
  /** Optional workspace-relative paths the answering agent should read first. */
  contextFiles?: string[]
  /** Optional per-call timeout in ms. */
  timeoutMs?: number
  /** Target a specific session of the peer; omitted uses its latest session. */
  sessionId?: string
  /** When true, the ask is queued: the server returns an askId immediately. */
  async?: boolean
}

export interface AskSuccess {
  ok: true
  /** The answering agent's committed text. */
  answer: string
  /** True when the answer was cut at the character cap or the timeout. */
  truncated: boolean
}

/** Returned for `async: true` asks: accepted, answer arrives later. */
export interface AskAccepted {
  ok: true
  /** Poll this id with GET /ask/status?askId= or the ask_result tool. */
  askId: string
}

export type AskStatus =
  | 'pending'
  | 'running'
  | 'answered'
  | 'declined'
  | 'failed'

/** The live state of one async ask. */
export interface AskStatusSuccess {
  ok: true
  status: AskStatus
  answer?: string
  truncated?: boolean
  error?: string
}

export interface AskFailure {
  ok: false
  error: { code: string; message: string }
}

export type AskResponse = AskSuccess | AskAccepted | AskFailure

export const errorResponse = (code: string, message: string): AskFailure => ({
  ok: false,
  error: { code, message },
})
