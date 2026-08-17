import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { Config, PeerConfig } from './config.ts'

/**
 * Plugin-owned settings: dsh rc.6 only exposes allowlisted namespaces to the
 * web settings API, so the plugin persists its friends/about data itself
 * (a JSON file next to the keys) and serves it through its own HTTP endpoints.
 */

/**
 * Runtime knobs that used to live only in the dsh profile patch
 * (`cordis.patch.yml`). They are now owned by the settings file and editable
 * from the Ask Peer settings page; the profile values are the first-run
 * defaults (bootstrap), and the settings file wins afterwards.
 */
export interface LocalSettings {
  /** Bind host for the inbound ask server; keep 127.0.0.1 unless you trust the LAN. */
  listenHost: string
  /** Bind port for the inbound ask server. */
  listenPort: number
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
  /** Roster refresh interval in ms; 0 disables periodic refresh (initial fetch still runs). */
  rosterRefreshMs: number
}

export interface AskPeerSettings {
  description: string
  tags: string[]
  peers: PeerConfig[]
  local: LocalSettings
}

export const LocalSettingsSchema: Schema<LocalSettings> = Schema.object({
  listenHost: Schema.string().default('127.0.0.1'),
  listenPort: Schema.number().default(3877),
  requireToken: Schema.boolean().default(true),
  workspace: Schema.string().default(process.cwd()),
  provider: Schema.string(),
  model: Schema.string(),
  timeoutMs: Schema.number().default(120000),
  maxAnswerChars: Schema.number().default(48000),
  approvalTimeoutMs: Schema.number().default(120000),
  allowExecution: Schema.boolean().default(false),
  rosterRefreshMs: Schema.number().default(60000),
})

export const AskPeerSettingsSchema: Schema<AskPeerSettings> = Schema.object({
  description: Schema.string().default(''),
  tags: Schema.array(Schema.string()).default([]),
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
  local: LocalSettingsSchema,
})

/** Snapshot the profile-config runtime knobs as the settings-file defaults. */
export function localFromConfig(config: Config): LocalSettings {
  return {
    listenHost: config.listenHost,
    listenPort: config.listenPort,
    requireToken: config.requireToken,
    workspace: config.workspace,
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
    timeoutMs: config.timeoutMs,
    maxAnswerChars: config.maxAnswerChars,
    approvalTimeoutMs: config.approvalTimeoutMs,
    allowExecution: config.allowExecution,
    rosterRefreshMs: config.rosterRefreshMs,
  }
}

/** Defensive merge: valid stored values win, anything else falls back to defaults. */
function mergeLocal(stored: unknown, defaults: LocalSettings): LocalSettings {
  if (typeof stored !== 'object' || stored === null) return { ...defaults }
  const raw = stored as Record<string, unknown>
  const provider = typeof raw.provider === 'string' && raw.provider !== '' ? raw.provider : defaults.provider
  const model = typeof raw.model === 'string' && raw.model !== '' ? raw.model : defaults.model
  return {
    listenHost:
      typeof raw.listenHost === 'string' && raw.listenHost !== '' ? raw.listenHost : defaults.listenHost,
    listenPort:
      typeof raw.listenPort === 'number' && raw.listenPort > 0 && raw.listenPort < 65536
        ? raw.listenPort
        : defaults.listenPort,
    requireToken: typeof raw.requireToken === 'boolean' ? raw.requireToken : defaults.requireToken,
    workspace: typeof raw.workspace === 'string' && raw.workspace !== '' ? raw.workspace : defaults.workspace,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    timeoutMs: typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0 ? raw.timeoutMs : defaults.timeoutMs,
    maxAnswerChars:
      typeof raw.maxAnswerChars === 'number' && raw.maxAnswerChars > 0
        ? raw.maxAnswerChars
        : defaults.maxAnswerChars,
    approvalTimeoutMs:
      typeof raw.approvalTimeoutMs === 'number' && raw.approvalTimeoutMs > 0
        ? raw.approvalTimeoutMs
        : defaults.approvalTimeoutMs,
    allowExecution: typeof raw.allowExecution === 'boolean' ? raw.allowExecution : defaults.allowExecution,
    rosterRefreshMs:
      typeof raw.rosterRefreshMs === 'number' && raw.rosterRefreshMs >= 0
        ? raw.rosterRefreshMs
        : defaults.rosterRefreshMs,
  }
}

/** What is stored on disk: the settings plus the browser's write token. */
export interface StoredSettings {
  settings: AskPeerSettings
  uiToken: string
}

export function settingsFilePath(keyDir: string, name: string): string {
  return join(resolve(keyDir), `settings-${name}.json`)
}

/**
 * Load the plugin-owned settings file, creating it with the composition
 * defaults (and a fresh UI token) on first use. Malformed files fall back to
 * the defaults rather than breaking the plugin.
 */
export function loadSettings(
  keyDir: string,
  name: string,
  defaults: AskPeerSettings,
): StoredSettings {
  const file = settingsFilePath(keyDir, name)
  const fallback: StoredSettings = {
    settings: defaults,
    uiToken: randomBytes(24).toString('base64url'),
  }
  if (!existsSync(file)) {
    mkdirSync(resolve(keyDir), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${JSON.stringify(fallback, null, 2)}\n`, { mode: 0o600 })
    return fallback
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredSettings>
    const settings = parsed.settings
    if (settings === undefined || typeof settings !== 'object') return fallback
    return {
      settings: {
        description: typeof settings.description === 'string' ? settings.description : defaults.description,
        tags: Array.isArray(settings.tags) ? settings.tags.filter((t): t is string => typeof t === 'string') : defaults.tags,
        peers: Array.isArray(settings.peers) ? settings.peers : defaults.peers,
        local: mergeLocal(settings.local, defaults.local),
      },
      uiToken: typeof parsed.uiToken === 'string' && parsed.uiToken.length > 0 ? parsed.uiToken : fallback.uiToken,
    }
  } catch {
    return fallback
  }
}

/** Persist the plugin-owned settings (and the UI token) to disk. */
export function saveSettings(keyDir: string, name: string, stored: StoredSettings): void {
  const file = settingsFilePath(keyDir, name)
  mkdirSync(resolve(keyDir), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
}
