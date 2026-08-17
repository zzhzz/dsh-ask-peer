import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { PeerConfig } from './config.ts'

/**
 * Plugin-owned settings: dsh rc.6 only exposes allowlisted namespaces to the
 * web settings API, so the plugin persists its friends/about data itself
 * (a JSON file next to the keys) and serves it through its own HTTP endpoints.
 */
export interface AskPeerSettings {
  description: string
  tags: string[]
  peers: PeerConfig[]
}

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
})

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
