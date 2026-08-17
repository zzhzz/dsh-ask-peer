import { useEffect, useState } from 'react'
import type { PeerConfig } from '../config.ts'
import type { AskPeerSettings, LocalSettings } from '../settings.ts'

type FriendMode = 'ask' | 'auto' | 'deny'

interface FriendDraft {
  name: string
  host: string
  port: number
  token: string
  publicKey: string
  mode: FriendMode
  description: string
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
  return { name: '', host: '', port: 3877, token: '', publicKey: '', mode: 'ask', description: '' }
}

function toDraft(peer: PeerConfig): FriendDraft {
  return {
    name: peer.name,
    host: peer.host,
    port: peer.port,
    token: peer.token ?? '',
    publicKey: peer.publicKey ?? '',
    mode: peer.mode ?? 'ask',
    description: peer.description ?? '',
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
    ...(draft.description !== '' ? { description: draft.description } : {}),
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
  const [notice, setNotice] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [tagsText, setTagsText] = useState('')
  const [friends, setFriends] = useState<FriendDraft[]>([])
  const [draft, setDraft] = useState<FriendDraft>(emptyFriend())
  const [local, setLocal] = useState<LocalSettings | null>(null)
  const [card, setCard] = useState('')
  const [cardExpires, setCardExpires] = useState('')
  const [pasteCard, setPasteCard] = useState('')
  const [identity, setIdentity] = useState<{ publicKey: string; fingerprint: string } | null>(null)
  const [token, setToken] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const [copiedCard, setCopiedCard] = useState(false)
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
      setLocal(document.settings.local)

      const cardResponse = await fetch(`${config.serverUrl}/sign/card`)
      if (cardResponse.ok) {
        const cardDocument = (await cardResponse.json()) as { card: string; expiresAt: number }
        setCard(cardDocument.card)
        setCardExpires(new Date(cardDocument.expiresAt).toLocaleString())
      } else {
        setCard('')
        setCardExpires('')
      }
      setStatus('ready')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setNotice(null)
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
            local: local ?? undefined,
          },
        }),
      })
      if (!response.ok) throw new Error(`save rejected (HTTP ${response.status})`)
      setNotice('Saved.')
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

  const copyCard = async (): Promise<void> => {
    if (card === '') return
    try {
      await navigator.clipboard.writeText(card)
      setCopiedCard(true)
      setTimeout(() => setCopiedCard(false), 1500)
    } catch {
      setError('clipboard unavailable')
    }
  }

  const decodeCard = async (): Promise<void> => {
    const value = pasteCard.trim()
    if (value === '' || serverUrl === '') return
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`${serverUrl}/sign/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ card: value }),
      })
      const result = (await response.json()) as
        | { ok: true; peer: { name: string; host: string; port: number; publicKey: string; description?: string } }
        | { ok: false; reason: string }
      if (result.ok) {
        setDraft({
          name: result.peer.name,
          host: result.peer.host,
          port: result.peer.port,
          token: '',
          publicKey: result.peer.publicKey,
          mode: 'ask',
          description: result.peer.description ?? '',
        })
        setPasteCard('')
        setNotice(`Friend card from ${result.peer.name} verified. Review the details and press Add.`)
      } else {
        setNotice(null)
        setError(`Friend card rejected: ${result.reason}`)
      }
    } catch (cause) {
      setNotice(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
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
        <div style={styles.heading}>My friend card</div>
        <div style={styles.row}>
          <div style={styles.wide}>
            <div style={styles.label}>
              One signed blob with everything friends need (name, host, port, sign, about).
              Friends paste it into “Add friend from a card” below.
            </div>
            {card !== '' ? (
              <>
                <div style={styles.mono}>{card}</div>
                <div style={styles.muted}>valid until {cardExpires}</div>
              </>
            ) : (
              <div style={styles.muted}>card unavailable (inbound ask server not running?)</div>
            )}
          </div>
          {card !== '' ? (
            <button type="button" style={styles.button} onClick={() => void copyCard()}>
              {copiedCard ? 'Copied' : 'Copy'}
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
        <div style={styles.heading}>Local agent settings</div>
        <div style={styles.row}>
          <input
            style={{ ...styles.input, width: 120 }}
            value={local?.listenHost ?? ''}
            placeholder="listen host"
            onChange={(event) => setLocal({ ...local!, listenHost: event.target.value })}
          />
          <input
            style={{ ...styles.input, width: 70 }}
            type="number"
            value={local?.listenPort ?? 3877}
            placeholder="listen port"
            onChange={(event) => setLocal({ ...local!, listenPort: Number(event.target.value) })}
          />
          <label style={styles.label}>
            <input
              type="checkbox"
              checked={local?.requireToken ?? true}
              onChange={(event) => setLocal({ ...local!, requireToken: event.target.checked })}
            />{' '}
            require token
          </label>
        </div>
        <div style={{ ...styles.row, marginTop: 6 }}>
          <input
            style={{ ...styles.input, ...styles.wide }}
            value={local?.workspace ?? ''}
            placeholder="answering workspace (absolute path)"
            onChange={(event) => setLocal({ ...local!, workspace: event.target.value })}
          />
        </div>
        <div style={{ ...styles.row, marginTop: 6 }}>
          <input
            style={{ ...styles.input, width: 160 }}
            value={local?.provider ?? ''}
            placeholder="provider override (optional)"
            onChange={(event) => setLocal({ ...local!, provider: event.target.value })}
          />
          <input
            style={{ ...styles.input, width: 140 }}
            value={local?.model ?? ''}
            placeholder="model override (optional)"
            onChange={(event) => setLocal({ ...local!, model: event.target.value })}
          />
          <input
            style={{ ...styles.input, width: 110 }}
            type="number"
            value={local?.timeoutMs ?? 120000}
            placeholder="ask timeout ms"
            onChange={(event) => setLocal({ ...local!, timeoutMs: Number(event.target.value) })}
          />
        </div>
        <div style={{ ...styles.row, marginTop: 6 }}>
          <input
            style={{ ...styles.input, width: 120 }}
            type="number"
            value={local?.maxAnswerChars ?? 48000}
            placeholder="answer cap chars"
            onChange={(event) => setLocal({ ...local!, maxAnswerChars: Number(event.target.value) })}
          />
          <input
            style={{ ...styles.input, width: 130 }}
            type="number"
            value={local?.approvalTimeoutMs ?? 120000}
            placeholder="approval timeout ms"
            onChange={(event) => setLocal({ ...local!, approvalTimeoutMs: Number(event.target.value) })}
          />
          <input
            style={{ ...styles.input, width: 110 }}
            type="number"
            value={local?.rosterRefreshMs ?? 60000}
            placeholder="roster refresh ms"
            onChange={(event) => setLocal({ ...local!, rosterRefreshMs: Number(event.target.value) })}
          />
          <label style={styles.label}>
            <input
              type="checkbox"
              checked={local?.allowExecution ?? false}
              onChange={(event) => setLocal({ ...local!, allowExecution: event.target.checked })}
            />{' '}
            allow execution
          </label>
        </div>
        <div style={styles.muted}>host/port changes apply after the profile restarts.</div>
      </div>

      <div style={styles.block}>
        <div style={styles.heading}>Add friend from a card</div>
        <div style={styles.row}>
          <input
            style={{ ...styles.input, flex: 1, minWidth: 220 }}
            value={pasteCard}
            placeholder="paste a dsh-ask-peer-card:… signature"
            onChange={(event) => setPasteCard(event.target.value)}
          />
          <button type="button" style={styles.button} onClick={() => void decodeCard()}>
            Verify & fill
          </button>
        </div>
        <div style={styles.muted}>the card is verified against the key embedded in it, then pre-fills the friend form.</div>
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
        {draft.description !== '' ? (
          <div style={{ ...styles.muted, marginTop: 6 }}>note: {draft.description}</div>
        ) : null}
      </div>

      {error !== null ? <div style={styles.error}>{error}</div> : null}
      {notice !== null ? <div style={styles.muted}>{notice}</div> : null}
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
