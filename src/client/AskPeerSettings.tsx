import { useEffect, useState } from 'react'
import type { PeerConfig } from '../config.ts'
import type { AskPeerSettings } from '../settings.ts'

type FriendMode = 'ask' | 'auto' | 'deny'

interface FriendDraft {
  name: string
  host: string
  port: number
  token: string
  publicKey: string
  mode: FriendMode
}

const styles: Record<string, React.CSSProperties> = {
  card: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 640 },
  block: { border: '1px solid #d8dee6', borderRadius: 10, padding: 12, background: '#fbfcfe' },
  heading: { fontWeight: 600, marginBottom: 8 },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  label: { fontSize: 12, color: '#667' },
  input: { padding: '4px 8px', borderRadius: 6, border: '1px solid #c3cbd6', background: '#fff' },
  wide: { flex: 1, minWidth: 180 },
  button: { padding: '4px 12px', borderRadius: 6, border: '1px solid #c3cbd6', background: '#fff', cursor: 'pointer' },
  primary: { background: '#1f6feb', borderColor: '#1f6feb', color: '#fff' },
  mono: { fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' },
  error: { color: '#c62828' },
  muted: { color: '#667', fontSize: 12 },
}

function emptyFriend(): FriendDraft {
  return { name: '', host: '', port: 3877, token: '', publicKey: '', mode: 'ask' }
}

function toDraft(peer: PeerConfig): FriendDraft {
  return {
    name: peer.name,
    host: peer.host,
    port: peer.port,
    token: peer.token ?? '',
    publicKey: peer.publicKey ?? '',
    mode: peer.mode ?? 'ask',
  }
}

function toPeer(draft: FriendDraft): PeerConfig {
  return {
    name: draft.name,
    host: draft.host,
    port: draft.port,
    ...(draft.token !== '' ? { token: draft.token } : {}),
    ...(draft.publicKey !== '' ? { publicKey: draft.publicKey } : {}),
    mode: draft.mode,
  }
}

interface ConfigDocument {
  serverUrl: string
  identity: { publicKey: string; fingerprint: string }
  uiToken: string
}

/**
 * The Ask Peer settings page. Data flows through the plugin's own HTTP
 * channel: a same-origin config route (server URL, identity, write token)
 * plus GET/POST /settings on the ask server.
 */
export function AskPeerSettingsSection() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [tagsText, setTagsText] = useState('')
  const [friends, setFriends] = useState<FriendDraft[]>([])
  const [draft, setDraft] = useState<FriendDraft>(emptyFriend())
  const [identity, setIdentity] = useState<{ publicKey: string; fingerprint: string } | null>(null)
  const [token, setToken] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = async (): Promise<void> => {
    setStatus('loading')
    try {
      const configResponse = await fetch('/ask-peer/config')
      if (!configResponse.ok) throw new Error('config route unavailable (is the host plugin loaded?)')
      const config = (await configResponse.json()) as ConfigDocument
      setIdentity(config.identity)
      setToken(config.uiToken)
      setServerUrl(config.serverUrl)

      const settingsResponse = await fetch(`${config.serverUrl}/settings`)
      if (!settingsResponse.ok) throw new Error(`ask server unreachable at ${config.serverUrl}`)
      const document = (await settingsResponse.json()) as { settings: AskPeerSettings }
      setDescription(document.settings.description ?? '')
      setTagsText((document.settings.tags ?? []).join(', '))
      setFriends((document.settings.peers ?? []).map(toDraft))
      setStatus('ready')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    }
  }

  useEffect(() => {
    void load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (): Promise<void> => {
    if (saving || serverUrl === '' || token === '') return
    setSaving(true)
    try {
      const response = await fetch(`${serverUrl}/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          settings: {
            description,
            tags: tagsText.split(',').map((s) => s.trim()).filter((s) => s !== ''),
            peers: friends.map(toPeer),
          },
        }),
      })
      if (!response.ok) throw new Error(`save rejected (HTTP ${response.status})`)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const addFriend = (): void => {
    const name = draft.name.trim()
    const host = draft.host.trim()
    if (name === '' || host === '') return
    setFriends([...friends, { ...draft, name, host }])
    setDraft(emptyFriend())
  }

  const copySign = async (): Promise<void> => {
    if (identity === null) return
    try {
      await navigator.clipboard.writeText(identity.publicKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('clipboard unavailable')
    }
  }

  if (status === 'loading') return <div style={styles.muted}>Loading…</div>
  if (status === 'error') return <div style={styles.error}>{error}</div>

  return (
    <div style={styles.card}>
      <div style={styles.block}>
        <div style={styles.heading}>My sign</div>
        <div style={styles.row}>
          <div style={styles.wide}>
            <div style={styles.label}>Share this with friends (the private key stays on this machine)</div>
            <div style={styles.mono}>{identity?.publicKey ?? ''}</div>
            {identity !== null ? <div style={styles.muted}>fingerprint {identity.fingerprint}</div> : null}
          </div>
          {identity !== null ? (
            <button type="button" style={styles.button} onClick={() => void copySign()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          ) : null}
        </div>
      </div>

      <div style={styles.block}>
        <div style={styles.heading}>About this agent</div>
        <div style={styles.row}>
          <input
            style={{ ...styles.input, ...styles.wide }}
            value={description}
            placeholder="Description (what you know)"
            onChange={(event) => setDescription(event.target.value)}
          />
          <input
            style={{ ...styles.input, ...styles.wide }}
            value={tagsText}
            placeholder="Tags, comma-separated (env-setup, docker)"
            onChange={(event) => setTagsText(event.target.value)}
          />
        </div>
      </div>

      <div style={styles.block}>
        <div style={styles.heading}>Friends</div>
        {friends.map((friend, index) => (
          <div key={index} style={{ ...styles.row, marginBottom: 6 }}>
            <input
              style={{ ...styles.input, width: 90 }}
              value={friend.name}
              onChange={(event) => update(index, { name: event.target.value })}
            />
            <input
              style={{ ...styles.input, width: 110 }}
              value={friend.host}
              onChange={(event) => update(index, { host: event.target.value })}
            />
            <input
              style={{ ...styles.input, width: 60 }}
              type="number"
              value={friend.port}
              onChange={(event) => update(index, { port: Number(event.target.value) })}
            />
            <select
              style={styles.input}
              value={friend.mode}
              onChange={(event) => update(index, { mode: event.target.value as FriendMode })}
            >
              <option value="ask">ask</option>
              <option value="auto">auto</option>
              <option value="deny">deny</option>
            </select>
            <input
              style={{ ...styles.input, flex: 1, minWidth: 140 }}
              value={friend.publicKey}
              placeholder="ed25519:… (their sign)"
              onChange={(event) => update(index, { publicKey: event.target.value })}
            />
            <button type="button" style={styles.button} onClick={() => remove(index)}>
              Remove
            </button>
          </div>
        ))}
        <div style={{ ...styles.row, marginTop: 8 }}>
          <input
            style={{ ...styles.input, width: 90 }}
            placeholder="name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <input
            style={{ ...styles.input, width: 110 }}
            placeholder="host"
            value={draft.host}
            onChange={(event) => setDraft({ ...draft, host: event.target.value })}
          />
          <input
            style={{ ...styles.input, width: 60 }}
            type="number"
            placeholder="port"
            value={draft.port}
            onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })}
          />
          <select
            style={styles.input}
            value={draft.mode}
            onChange={(event) => setDraft({ ...draft, mode: event.target.value as FriendMode })}
          >
            <option value="ask">ask</option>
            <option value="auto">auto</option>
            <option value="deny">deny</option>
          </select>
          <input
            style={{ ...styles.input, flex: 1, minWidth: 140 }}
            placeholder="ed25519:… (their sign)"
            value={draft.publicKey}
            onChange={(event) => setDraft({ ...draft, publicKey: event.target.value })}
          />
          <button type="button" style={{ ...styles.button, ...styles.primary }} onClick={addFriend}>
            Add
          </button>
        </div>
      </div>

      {error !== null ? <div style={styles.error}>{error}</div> : null}
      <div style={styles.row}>
        <button
          type="button"
          style={{ ...styles.button, ...styles.primary }}
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )

  function update(index: number, patch: Partial<FriendDraft>): void {
    setFriends(friends.map((friend, i) => (i === index ? { ...friend, ...patch } : friend)))
  }

  function remove(index: number): void {
    setFriends(friends.filter((_, i) => i !== index))
  }
}
