import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_KEY_DIR } from './identity.ts'

/**
 * One colleague agent this agent may ask (outbound) and, when configured on
 * both sides, may answer (inbound). Both sides keep their own copy; there is
 * no central registry.
 */
export interface PeerConfig {
  /** Peer name, matching the peer's `callerName` on its own side. */
  name: string
  /** Host or IP of the peer's ask server. */
  host: string
  /** Port of the peer's ask server. */
  port: number
  /** Optional shared secret; the peer requires it when `requireToken` is on. */
  token?: string
  /**
   * The peer's public sign (`ed25519:...`). When set, it replaces the shared
   * token as the trust root: every ask and advertisement from that peer must
   * carry a signature verifiable against this key.
   */
  publicKey?: string
  /** Inbound policy for this friend: ask the owner, auto-answer, or deny. Defaults to `ask`. */
  mode?: 'ask' | 'auto' | 'deny'
  /** Optional note describing whose agent this is. */
  description?: string
}

export interface Config {
  /** Identity presented to peers on outbound asks; peers allowlist this name. */
  callerName: string
  /** Directory holding this agent's signing keys (private key never leaves). */
  keyDir: string
  /** Self-advertised description shown to asking agents (what you know). */
  description: string
  /** Self-advertised topic tags used by asking agents for peer selection. */
  tags: string[]
  /** Roster refresh interval in ms; 0 disables periodic refresh (initial fetch still runs). */
  rosterRefreshMs: number
  /** Start the inbound ask server. */
  listen: boolean
  /** Bind host for the inbound ask server; keep 127.0.0.1 unless you trust the LAN. */
  listenHost: string
  /** Bind port for the inbound ask server. */
  listenPort: number
  /** Peers we may ask; also the inbound caller allowlist. */
  peers: PeerConfig[]
  /** Require a matching shared token on every inbound ask. */
  requireToken: boolean
  /** Workspace the answering agent runs in. */
  workspace: string
  /** Provider route for answering agents; harness default when omitted. */
  provider?: string
  /** Model for answering agents; harness default when omitted. */
  model?: string
  /** Default outbound timeout in ms. */
  timeoutMs: number
  /** Answer character cap; longer answers are cut and marked truncated. */
  maxAnswerChars: number
  /** How long an inbound ask in `ask` mode waits for the owner before failing closed. */
  approvalTimeoutMs: number
  /**
   * Let ask-owned agents request tool permissions through the normal approval
   * flow. When false (default), every permission request from an ask-owned
   * agent is auto-rejected, so an inbound ask can only read and explain.
   */
  allowExecution: boolean
}

export const Config: Schema<Config> = Schema.object({
  callerName: Schema.string().default('local'),
  keyDir: Schema.string().default(DEFAULT_KEY_DIR),
  description: Schema.string().default(''),
  tags: Schema.array(Schema.string()).default([]),
  rosterRefreshMs: Schema.number().default(60000),
  listen: Schema.boolean().default(false),
  listenHost: Schema.string().default('127.0.0.1'),
  listenPort: Schema.number().default(3877),
  peers: Schema.array(
    Schema.object({
      name: Schema.string().required(),
      host: Schema.string().required(),
      port: Schema.number().default(3877),
      token: Schema.string(),
      publicKey: Schema.string(),
      mode: Schema.union(['ask', 'auto', 'deny']),
      description: Schema.string(),
    }),
  ).default([]),
  requireToken: Schema.boolean().default(true),
  workspace: Schema.string().default(process.cwd()),
  provider: Schema.string(),
  model: Schema.string(),
  timeoutMs: Schema.number().default(120000),
  maxAnswerChars: Schema.number().default(48000),
  approvalTimeoutMs: Schema.number().default(120000),
  allowExecution: Schema.boolean().default(false),
})
