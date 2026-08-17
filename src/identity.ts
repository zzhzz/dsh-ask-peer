import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * One agent's signing identity. The public key (the "sign") is shared with
 * friends and proves who wrote an ask or advertisement; the private key never
 * leaves the machine.
 */
export interface Identity {
  /** Public sign in `ed25519:<base64url spki>` form. */
  publicKey: string
  /** PEM-encoded Ed25519 private key, stored with 0600 permissions. */
  privateKey: string
}

/** Load the agent's identity from `keyDir`, generating and persisting it on first use. */
export function loadOrCreateIdentity(keyDir: string, name: string): Identity {
  const dir = resolve(keyDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const pubFile = join(dir, `${name}.pub`)
  const keyFile = join(dir, `${name}.key`)
  if (existsSync(pubFile) && existsSync(keyFile)) {
    return {
      publicKey: readFileSync(pubFile, 'utf8').trim(),
      privateKey: readFileSync(keyFile, 'utf8'),
    }
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicSign = `ed25519:${Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64url')}`
  writeFileSync(pubFile, `${publicSign}\n`, { mode: 0o644 })
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  writeFileSync(keyFile, privatePem, { mode: 0o600 })
  return { publicKey: publicSign, privateKey: privatePem }
}

/**
 * Deterministic canonical JSON: object keys sorted, undefined properties
 * dropped, arrays and scalars flattened. Both sides derive the same bytes,
 * which is what a signature is bound to.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`)
}

/** Sign a canonical payload with the PEM private key; returns a base64url signature. */
export function signPayload(privateKeyPem: string, canonical: string): string {
  return cryptoSign(null, Buffer.from(canonical, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64url')
}

/** Verify a base64url signature over a canonical payload against an `ed25519:` public sign. */
export function verifyPayload(publicSign: string, canonical: string, signature: string): boolean {
  const b64 = publicSign.startsWith('ed25519:') ? publicSign.slice('ed25519:'.length) : publicSign
  try {
    const pem = Buffer.from(b64, 'base64url').toString('utf8')
    return cryptoVerify(null, Buffer.from(canonical, 'utf8'), createPublicKey(pem), Buffer.from(signature, 'base64url'))
  } catch {
    return false
  }
}

/** A short, human-readable form of the public sign for display in the roster. */
export function shortSign(publicSign: string): string {
  return publicSign.startsWith('ed25519:') ? publicSign.slice(0, 23) : publicSign.slice(0, 16)
}

export const DEFAULT_KEY_DIR = join(homedir(), '.dsh-ask-peer', 'keys')
